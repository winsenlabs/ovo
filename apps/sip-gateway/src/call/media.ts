import { decodeBase64, type SipMediaFrameOut } from '@winsendotai/ovo-sip-carrier-kit';
import { z } from 'zod';
import type { StreamGrant } from '../bridge/admission.ts';
import { MediaLink } from '../bridge/media-ws.ts';
import { carrierPath, signedPost } from '../bridge/signed-http.ts';
import { PlayoutQueue } from '../media/playout.ts';
import { Pacer } from '../rtp/pacer.ts';
import { RtpSession, type RtpStats } from '../rtp/session.ts';
import type { RtpPair } from '../rtp/socket-pool.ts';
import type { MediaChoice } from '../sdp/negotiate.ts';
import { contains } from '../config/trunks.ts';
import type { Call } from './call.ts';
import type { CallHost } from './host.ts';

/** No RTP for this long while not on hold ends the call (§4.4). */
export const MEDIA_TIMEOUT_MS = 30_000;
/** `terminate` lets queued playout finish, but never for longer than this (§4.5). */
export const TERMINATE_DRAIN_MS = 5_000;
/** Resume must land inside the worker's 30 s window. */
export const RESUME_WINDOW_MS = 25_000;
/** Upstream audio kept while the socket is down (2 s), sent on reconnect with its own seq. */
const RESUME_BUFFER_FRAMES = 100;

const ResumeReply = z.union([
  z.object({ kind: z.literal('ended') }),
  z.object({
    kind: z.literal('stream'),
    mediaUrl: z.string(),
    routeParams: z.record(z.string(), z.string()),
    resumeUrl: z.string().optional(),
    statusUrl: z.string().optional(),
  }),
]);

export interface CallMediaInit {
  callId: string;
  carrierId: string;
  bindingId: string;
  pair: RtpPair;
  choice: MediaChoice;
  mediaCidrs: (address: string) => boolean;
  grant: StreamGrant;
  /** The media side wants the call over: playout drained after terminate, overflow, resume gone. */
  onEnd(reason: string): void;
}

/**
 * The media half of a call: RTP ↔ the gateway's carrier socket, paced every 20 ms. `seq` and
 * `tsMs` belong to the call, not the socket, so they never reset across resumes.
 */
export class CallMedia {
  readonly rtp: RtpSession;
  readonly playout = new PlayoutQueue();
  readonly pacer: Pacer;
  grant: StreamGrant;
  private link?: MediaLink;
  private seq = 0;
  private frames = 0;
  private buffered: { tsMs: number; payload: Uint8Array }[] = [];
  private resuming = false;
  private stopped = false;
  private detached = false;
  terminating = false;
  private cancelTerminate?: () => void;

  constructor(
    private readonly host: CallHost,
    private readonly init: CallMediaInit,
  ) {
    this.grant = init.grant;
    this.rtp = new RtpSession({
      pair: init.pair,
      choice: init.choice,
      allowMedia: init.mediaCidrs,
      clock: host.clock,
      cname: `ovo@${host.config.advertisedHost}`,
      onDtmf: (event) => this.link?.dtmf(event.digit, event.durationMs),
    });
    this.pacer = new Pacer(host.clock, () => this.tick());
  }

  get streamId(): string | undefined {
    return this.link?.streamId;
  }

  /** Opens the carrier socket for the current grant; throws when the gateway refuses it. */
  async connect(): Promise<void> {
    const link = await MediaLink.open({
      target: this.host.bridge,
      mediaUrl: this.grant.mediaUrl,
      callId: this.init.callId,
      routeParams: this.grant.routeParams,
      handlers: {
        onFrame: (frame) => this.onFrame(frame),
        onProtocolError: (reason) =>
          this.host.logger.warn('sip.media_frame_rejected', { callId: this.init.callId, reason }),
        onClose: ({ byUs }) => {
          if (!byUs && !this.stopped && !this.terminating) void this.resume();
        },
      },
    });
    // The call ended while the socket was opening: it must not outlive the call.
    if (this.stopped) return link.close(1000);
    this.link = link;
  }

  start(): void {
    this.pacer.begin();
  }

  /** A digit from SIP INFO `application/dtmf-relay` (RFC 4733 digits arrive through RTP). */
  dtmf(digit: string, durationMs?: number): void {
    this.link?.dtmf(digit, durationMs);
  }

  update(choice: MediaChoice): void {
    this.rtp.update(choice);
    this.init.choice = choice;
  }

  /** On hold (we only send, or nothing flows): no inbound RTP is expected. */
  get onHold(): boolean {
    const direction = this.init.choice.direction;
    return direction === 'sendonly' || direction === 'inactive';
  }

  private tick(): void {
    const up = this.rtp.pullUpstream();
    const tsMs = 20 * this.frames;
    this.frames += 1;
    if (this.resuming) {
      this.buffered.push({ tsMs, payload: up.payload });
      if (this.buffered.length > RESUME_BUFFER_FRAMES) this.buffered.shift();
    } else this.link?.media(++this.seq, tsMs, up.payload);
    const out = this.playout.pop();
    this.rtp.sendDownstream(out.frame);
    for (const name of out.marks) this.link?.mark(name);
    this.host.counters.pacerMaxDriftMs = Math.max(
      this.host.counters.pacerMaxDriftMs,
      this.pacer.maxDriftMs,
    );
    if (this.terminating && this.playout.empty) return this.init.onEnd('terminate');
    if (!this.onHold && this.host.clock.now() - this.rtp.lastPacketAt > MEDIA_TIMEOUT_MS)
      this.init.onEnd('media_timeout');
  }

  private onFrame(frame: SipMediaFrameOut): void {
    if (this.stopped) return;
    switch (frame.event) {
      case 'media': {
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(frame.payload);
        } catch {
          this.host.logger.warn('sip.media_frame_rejected', {
            callId: this.init.callId,
            reason: 'base64',
          });
          return;
        }
        if (!this.playout.pushAudio(bytes)) {
          this.host.logger.warn('sip.playout_overflow', { callId: this.init.callId });
          this.init.onEnd('playout_overflow');
        }
        return;
      }
      case 'mark':
        this.playout.pushMark(frame.name);
        return;
      case 'clear':
        for (const name of this.playout.clear()) this.link?.mark(name);
        this.link?.cleared();
        return;
      case 'terminate':
        this.terminating = true;
        this.cancelTerminate ??= this.host.clock.setTimeout(
          () => this.init.onEnd('terminate'),
          TERMINATE_DRAIN_MS,
        );
    }
  }

  private async resume(): Promise<void> {
    if (this.resuming) return;
    this.resuming = true;
    const { callId, carrierId, bindingId } = this.init;
    const deadline = this.host.clock.now() + RESUME_WINDOW_MS;
    let delay = 250;
    while (!this.stopped && !this.detached && this.host.clock.now() < deadline) {
      this.host.counters.resumeAttempts += 1;
      try {
        const path = this.grant.resumeUrl
          ? carrierPath(this.grant.resumeUrl)
          : `/carriers/${carrierId}/${encodeURIComponent(bindingId)}/resume`;
        const reply = await signedPost(this.host.bridge, path, { v: 1, callId });
        const parsed = ResumeReply.safeParse(reply.json);
        if (reply.status === 200 && parsed.success) {
          if (parsed.data.kind === 'ended') {
            this.host.logger.info('sip.resume', { callId, result: 'ended' });
            return this.init.onEnd('resume_ended');
          }
          const { kind: _kind, ...grant } = parsed.data;
          this.grant = { ...this.grant, ...grant };
          if (this.stopped || this.detached) return;
          await this.connect();
          for (const frame of this.buffered.splice(0))
            this.link?.media(++this.seq, frame.tsMs, frame.payload);
          this.resuming = false;
          this.host.counters.resumeSuccesses += 1;
          this.host.logger.info('sip.resume', { callId, result: 'stream' });
          return;
        }
      } catch (error) {
        this.host.logger.warn('sip.resume', {
          callId,
          result: 'retry',
          error: (error as Error).message,
        });
      }
      await this.host.sleep(delay);
      delay = Math.min(delay * 2, 4_000);
    }
    if (!this.stopped && !this.detached) this.init.onEnd('resume_failed');
  }

  /**
   * A bridge takes over this leg's RTP: the carrier socket is told `transferred` and closed, and
   * the pacer stops, but the RTP session and its ports stay up for the bridge until `stop()`.
   */
  detach(): void {
    if (this.stopped || this.detached) return;
    this.detached = true;
    this.pacer.stop();
    this.cancelTerminate?.();
    this.link?.stop('transferred');
    this.link = undefined;
  }

  /** Stops pacing, tells the gateway (`stop`) unless it ended the stream, closes RTP. */
  stop(reason: 'caller-hangup' | 'stream-ended' | 'gateway' | 'transferred'): RtpStats {
    if (!this.stopped) {
      this.stopped = true;
      this.pacer.stop();
      this.cancelTerminate?.();
      if (reason === 'gateway') this.link?.close(1000);
      else this.link?.stop(reason);
      this.rtp.close();
      this.host.pool.release(this.init.pair);
      this.host.counters.jitterUnderruns += this.rtp.jitterStats.underruns;
    }
    return this.rtp.stats();
  }
}

/** The media half for `call` on its RTP pair; a media-side end hangs up with BYE. */
export function mediaForCall(
  host: CallHost,
  call: Call,
  choice: MediaChoice,
  grant: StreamGrant,
): CallMedia {
  return new CallMedia(host, {
    callId: call.callId,
    carrierId: call.trunk.carrierId,
    bindingId: call.trunk.bindingId,
    pair: call.pair!,
    choice,
    mediaCidrs: (address) => contains(call.trunk.media, address),
    grant,
    onEnd: (reason) =>
      call.end(reason, { bye: true, stream: reason === 'terminate' ? 'gateway' : 'stream-ended' }),
  });
}
