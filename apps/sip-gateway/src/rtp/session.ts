import { randomInt } from 'node:crypto';
import { alawToMulaw, mulawToAlaw } from '@winsendotai/ovo-audio';
import type { GatewayClock } from '../clock.ts';
import type { MediaChoice } from '../sdp/negotiate.ts';
import { DtmfReceiver, type DtmfEvent } from './dtmf4733.ts';
import { FRAME_SAMPLES, JitterBuffer } from './jitter.ts';
import { MediaLatch } from './latch.ts';
import { isRtcp, parseRtp, serializeRtp } from './packet.ts';
import { RtcpReporter, type PeerReport } from './rtcp.ts';
import { RtpSource } from './receiver.ts';
import type { RtpPair } from './socket-pool.ts';

export const RTCP_INTERVAL_MS = 5_000;
const MULAW_SILENCE = new Uint8Array(FRAME_SAMPLES).fill(0xff);

export interface RtpStats {
  packetsIn: number;
  packetsOut: number;
  lossPct: number;
  jitterMs: number;
  plcFrames: number;
}

export interface RtpSessionOptions {
  pair: RtpPair;
  choice: MediaChoice;
  /** Trunk media CIDRs (the signalled address is always allowed). */
  allowMedia: (address: string) => boolean;
  clock: GatewayClock;
  cname: string;
  onDtmf(event: DtmfEvent): void;
  onPeerReport?(report: PeerReport): void;
}

/**
 * One call's media leg: receive (latch, probation, jitter buffer, RFC 4733) and send (symmetric
 * RTP from the receive socket, PCMA transcoding, talkspurt M bit), with RTCP every 5 s.
 */
export class RtpSession {
  private choice: MediaChoice;
  private readonly latch: MediaLatch;
  private readonly jitter: JitterBuffer;
  private readonly dtmf = new DtmfReceiver();
  private readonly rtcp: RtcpReporter;
  private source?: RtpSource;
  private readonly ssrc = randomInt(1, 2 ** 32 - 1);
  private sequence = randomInt(0, 0xffff);
  private timestamp = randomInt(0, 2 ** 32 - 1);
  private talking = false;
  private sent = { packets: 0, octets: 0 };
  private cancelRtcp?: () => void;
  private closed = false;
  packetsIn = 0;
  lastPacketAt: number;
  peer?: PeerReport;

  constructor(private readonly options: RtpSessionOptions) {
    this.choice = options.choice;
    this.latch = new MediaLatch(options.choice.remote, options.allowMedia);
    this.jitter = new JitterBuffer({ silence: this.silenceByte() });
    this.rtcp = new RtcpReporter(this.ssrc, options.cname);
    this.lastPacketAt = options.clock.now();
    // A send to an unreachable peer surfaces as a socket 'error'; media keeps going regardless.
    for (const socket of [options.pair.rtp, options.pair.rtcp]) socket.on('error', () => undefined);
    options.pair.rtp.on('message', (data, rinfo) => this.receive(data, rinfo));
    options.pair.rtcp.on('message', (data) => {
      const report = this.rtcp.observe(data, options.clock.now());
      if (report) {
        this.peer = report;
        options.onPeerReport?.(report);
      }
    });
    this.scheduleRtcp();
  }

  private silenceByte(): number {
    return this.choice.codec === 'PCMA' ? 0xd5 : 0xff;
  }

  get destination() {
    return this.latch.destination;
  }

  get latchStats() {
    return { latches: this.latch.latches, ignored: this.latch.ignored };
  }

  /** A re-INVITE renegotiated: new remote address, direction or codec. */
  update(choice: MediaChoice): void {
    const codecChanged = choice.codec !== this.choice.codec;
    if (
      choice.remote.address !== this.choice.remote.address ||
      choice.remote.port !== this.choice.remote.port
    )
      this.latch.resignal(choice.remote);
    this.choice = choice;
    if (codecChanged) this.jitter.reset();
  }

  private receive(data: Buffer, rinfo: { address: string; port: number }): void {
    if (this.closed || isRtcp(data)) return;
    const packet = parseRtp(data);
    if (!packet) return;
    const isEvent = packet.payloadType === this.choice.tePt;
    const isAudio = packet.payloadType === this.choice.pt;
    if (!this.latch.accept(rinfo, packet, isEvent || isAudio)) return;
    this.lastPacketAt = this.options.clock.now();
    if (isEvent) {
      const event = this.dtmf.receive(packet.timestamp, packet.payload);
      if (event) this.options.onDtmf(event);
      return;
    }
    if (!isAudio) return;
    if (this.source?.ssrc !== packet.ssrc) {
      this.source = new RtpSource(packet.ssrc, packet.sequence);
      this.jitter.reset();
    }
    if (!this.source.update(packet.sequence)) return;
    this.packetsIn += 1;
    this.source.arrival(this.options.clock.now(), packet.timestamp);
    this.jitter.adapt(this.source.jitterMs);
    this.jitter.push(this.source.extendedTimestamp(packet.timestamp), packet.payload);
  }

  /** The next 20 ms of caller audio as μ-law; silence-concealed when packets are missing. */
  pullUpstream(): { payload: Uint8Array; concealed: boolean } {
    const { frame, concealed } = this.jitter.pop();
    return { payload: this.choice.codec === 'PCMA' ? alawToMulaw(frame) : frame, concealed };
  }

  /** Sends one 20 ms frame (μ-law in); silence when `frame` is undefined. */
  sendDownstream(frame?: Uint8Array): void {
    if (this.closed) return;
    const direction = this.choice.direction;
    const audio = frame ?? MULAW_SILENCE;
    const marker = frame !== undefined && !this.talking;
    this.talking = frame !== undefined;
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0;
    const to = this.latch.destination;
    if (direction === 'recvonly' || direction === 'inactive' || to.address === '0.0.0.0') return;
    const payload = this.choice.codec === 'PCMA' ? mulawToAlaw(audio) : audio;
    const bytes = serializeRtp({
      marker,
      payloadType: this.choice.pt,
      sequence: this.sequence,
      timestamp: this.timestamp,
      ssrc: this.ssrc,
      payload,
    });
    this.options.pair.rtp.send(bytes, to.port, to.address);
    this.sent.packets += 1;
    this.sent.octets += payload.length;
  }

  private report(bye: boolean): Buffer {
    const sender = this.sent.packets
      ? { ssrc: this.ssrc, ...this.sent, rtpTimestamp: this.timestamp }
      : undefined;
    const stats = this.source?.stats();
    const block =
      this.source && stats
        ? {
            ssrc: this.source.ssrc,
            expected: stats.expected,
            received: stats.packets,
            highestSequence: this.source.highestSequence,
            jitter: this.source.jitterUnits,
          }
        : undefined;
    const now = this.options.clock.now();
    return bye ? this.rtcp.bye(now, sender, block) : this.rtcp.build(now, sender, block);
  }

  private sendRtcp(bye: boolean): void {
    const to = this.latch.destination;
    try {
      this.options.pair.rtcp.send(this.report(bye), to.port + 1, to.address);
    } catch {
      // swallow-ok: RTCP is advisory; a closed socket at teardown loses only a report.
    }
  }

  private scheduleRtcp(): void {
    this.cancelRtcp = this.options.clock.setTimeout(() => {
      if (this.closed) return;
      this.sendRtcp(false);
      this.scheduleRtcp();
    }, RTCP_INTERVAL_MS);
  }

  stats(): RtpStats {
    const received = this.source?.stats();
    return {
      packetsIn: this.packetsIn,
      packetsOut: this.sent.packets,
      lossPct: received?.lossPct ?? 0,
      jitterMs: received?.jitterMs ?? 0,
      plcFrames: this.jitter.stats.concealedFrames,
    };
  }

  get jitterStats() {
    return this.jitter.stats;
  }

  /** RTCP BYE, then the caller releases the pair. */
  close(): void {
    if (this.closed) return;
    this.sendRtcp(true);
    this.closed = true;
    this.cancelRtcp?.();
  }
}
