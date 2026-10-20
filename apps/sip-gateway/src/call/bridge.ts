import { createHash, randomUUID } from 'node:crypto';
import { contains } from '../config/trunks.ts';
import { Pacer } from '../rtp/pacer.ts';
import type { MediaChoice } from '../sdp/negotiate.ts';
import { Call } from './call.ts';
import type { CallHost } from './host.ts';
import { CallMedia, MEDIA_TIMEOUT_MS } from './media.ts';
import { OutboundLeg } from './outbound-leg.ts';
import type { ReferResult } from './refer.ts';

/** A bridged call is not under the worker's clock any more, so the gateway bounds it. */
export const BRIDGE_MAX_SECONDS = 3600;

/** A dial ending before the answer that asking again could fix. */
const RETRYABLE = /^(sip_408|sip_503|invite_timeout|proxy_unresolvable)$/;

export interface BridgeTarget {
  /** The E.164 number, or the user part of a SIP URI (for logs only). */
  to: string;
  /** Request-URI when the destination is a SIP URI rather than `to` on the trunk's proxy. */
  requestUri?: string;
  headers: [string, string][];
}

/**
 * Stretch S1, for a trunk that refuses REFER: the gateway keeps the caller's leg, dials the
 * destination on the same trunk's outbound proxy and relays RTP between the two, a B2BUA with no
 * signalling interworking. While the destination rings the caller's media socket stays up (the
 * worker keeps playing hold); once it answers the worker's socket is told `transferred` and the two
 * legs run on one pacer. Each leg counts against OVO_SIP_MAX_CALLS, and either ending ends both.
 */
export class Bridge {
  state: 'dialing' | 'up' | 'ended' = 'dialing';
  readonly done: Promise<ReferResult>;
  private settle!: (result: ReferResult) => void;
  private outbound?: Call;
  private pacer?: Pacer;

  constructor(
    private readonly host: CallHost,
    private readonly inbound: Call,
    readonly requestId: string,
  ) {
    this.done = new Promise((resolve) => (this.settle = resolve));
  }

  /** Dials the destination. Resolves through `done`; never throws. */
  async dial(target: BridgeTarget, from: string): Promise<void> {
    const { host, inbound } = this;
    const pair = await host.pool.acquire();
    if (!pair || this.state !== 'dialing')
      return this.fail(
        'bridge_at_capacity',
        true,
        pair ? () => host.pool.release(pair) : undefined,
      );
    const callId = `${randomUUID()}@${host.config.advertisedHost}`;
    const out = new Call(host, callId, inbound.trunk, 'outbound', { from, to: target.to });
    out.pair = pair;
    out.bridge = this;
    this.outbound = out;
    host.registry.add(out);
    const ringSeconds = Math.ceil(host.config.referTimeoutMs / 1000);
    void new OutboundLeg(
      host,
      out,
      {
        requestId: this.requestId,
        ringTimeoutSec: ringSeconds,
        maxDurationSec: BRIDGE_MAX_SECONDS,
        credentials: null,
        invite: {
          ...(target.requestUri ? { requestUri: target.requestUri } : {}),
          headers: target.headers,
        },
      },
      (choice) => this.answered(out, choice),
    ).start();
  }

  private fail(reason: string, retryable: boolean, cleanup?: () => void): void {
    cleanup?.();
    if (this.state === 'ended') return;
    this.state = 'ended';
    if (this.inbound.bridge === this) this.inbound.bridge = undefined;
    this.settle({ kind: 'rejected', reason: reason.slice(0, 256), retryable });
  }

  private answered(out: Call, choice: MediaChoice): void {
    const { host, inbound } = this;
    if (this.state !== 'dialing' || inbound.phase !== 'confirmed' || !inbound.media) {
      out.end('bridge_caller_gone', { bye: true, stream: 'gateway', state: 'failed' });
      return;
    }
    // The destination's leg is a CallMedia that never opens a carrier socket: it owns the RTP
    // session and releases the ports on `stop()` like every other leg.
    const media = new CallMedia(host, {
      callId: out.callId,
      carrierId: out.trunk.carrierId,
      bindingId: out.trunk.bindingId,
      pair: out.pair!,
      choice,
      mediaCidrs: (address) => contains(out.trunk.media, address),
      grant: { mediaUrl: '', routeParams: {} },
      onEnd: () => undefined,
    });
    media.detach();
    out.media = media;
    inbound.media.detach();
    this.state = 'up';
    this.pacer = new Pacer(host.clock, () => this.tick());
    this.pacer.begin();
    host.logger.info('sip.bridge', { ...inbound.logFields, outbound: out.callId, result: 'up' });
    this.settle({
      kind: 'confirmed',
      receiptId: `sip-bridge:${createHash('sha256')
        .update(`${inbound.callId}|${this.requestId}`)
        .digest('hex')
        .slice(0, 32)}`,
    });
  }

  /** One 20 ms tick: each side's next frame goes to the other side. */
  private tick(): void {
    const { inbound, outbound, host } = this;
    const a = inbound.media;
    const b = outbound?.media;
    if (!a || !b) return;
    b.rtp.sendDownstream(a.rtp.pullUpstream().payload);
    a.rtp.sendDownstream(b.rtp.pullUpstream().payload);
    const now = host.clock.now();
    for (const [leg, media] of [
      [inbound, a],
      [outbound!, b],
    ] as const)
      if (!media.onHold && now - media.rtp.lastPacketAt > MEDIA_TIMEOUT_MS)
        return void leg.end('media_timeout', { bye: true, stream: 'stream-ended' });
  }

  /** A leg ended: before the answer that settles the handoff, after it the other leg goes too. */
  legEnded(call: Call): void {
    if (this.state === 'ended') return;
    const other = call === this.inbound ? this.outbound : this.inbound;
    if (this.state === 'dialing') {
      if (call === this.outbound)
        this.fail(
          `bridge_failed_${call.endReason ?? 'unknown'}`,
          RETRYABLE.test(call.endReason ?? ''),
        );
      else {
        this.fail('call_ended', false);
        other?.end('bridge_caller_gone', { bye: false, stream: 'gateway', state: 'canceled' });
      }
      return;
    }
    this.state = 'ended';
    this.pacer?.stop();
    this.host.logger.info('sip.bridge', {
      ...this.inbound.logFields,
      result: 'ended',
      cause: call.endReason,
    });
    other?.end('bridge_peer_ended', { bye: true, stream: 'stream-ended' });
  }
}

/** Starts a bridged handoff on `inbound`; resolves when the destination answered or failed. */
export function startBridge(
  host: CallHost,
  inbound: Call,
  input: { requestId: string; target: BridgeTarget; from: string },
): Promise<ReferResult> {
  const bridge = new Bridge(host, inbound, input.requestId);
  inbound.bridge = bridge;
  void bridge.dial(input.target, input.from);
  return bridge.done;
}
