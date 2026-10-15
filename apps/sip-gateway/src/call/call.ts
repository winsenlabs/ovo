import type { SipCallState } from '@winsendotai/ovo-sip-carrier-kit';
import { carrierPath, signedPostWithRetry } from '../bridge/signed-http.ts';
import type { Trunk } from '../config/trunks.ts';
import { last4 } from '../log.ts';
import type { RtpStats } from '../rtp/session.ts';
import type { RtpPair } from '../rtp/socket-pool.ts';
import { SdpOrigin, type LocalMedia } from '../sdp/negotiate.ts';
import { NORMAL_CLEARING, q850Cause } from '../sip/cause.ts';
import type { Dialog } from '../sip/dialog.ts';
import { TimerSet, type Flow } from '../sip/flow.ts';
import type { SipResponse } from '../sip/message.ts';
import { USER_AGENT } from '../sip/serialize.ts';
import { SessionTimer } from '../sip/session-timer.ts';
import type { CallHost } from './host.ts';
import { refreshSession } from './in-dialog.ts';
import type { CallMedia } from './media.ts';

export type CallPhase = 'early' | 'confirmed' | 'ending' | 'ended';

export interface EndOptions {
  /** Send BYE (we are hanging up) or not (they did, or the dialog never confirmed). */
  bye: boolean;
  /** Who ended the media stream, for the WS `stop` reason. */
  stream: 'caller-hangup' | 'stream-ended' | 'gateway';
  state?: SipCallState;
  sipCode?: number;
  reason?: string;
  /** Extra fields for the final status payload (`retryAfterSec`, …). */
  payload?: Record<string, unknown>;
}

/**
 * One SIP call (one dialog) and its media. Inbound and outbound set up differently but share the
 * confirmed phase: in-dialog requests, the session timer, status callbacks and teardown.
 */
export class Call {
  phase: CallPhase = 'early';
  dialog?: Dialog;
  /** The signalling flow the dialog started on (in-dialog requests reuse it when it is the next hop). */
  flow?: Flow;
  media?: CallMedia;
  /** The RTP pair, owned here until `media` takes it over. */
  pair?: RtpPair;
  readonly origin = new SdpOrigin();
  answer?: string;
  statusUrl?: string;
  answeredAt?: number;
  readonly createdAt: number;
  readonly timers: TimerSet;
  readonly sessionTimer: SessionTimer;
  endReason?: string;
  /** The negotiated trunk codec (PCMU/PCMA), reported in the final status. */
  codec?: string;
  localMedia?: LocalMedia;
  /** CSeq of the INVITE whose 2xx we are retransmitting until its ACK. */
  awaitingAck?: number;
  refreshing = false;
  sessionSeconds = 0;
  /** CANCEL, drain or a host hangup before the dialog confirmed. */
  readonly abort = new AbortController();
  /** Set by the inbound/outbound flow: how to finish an unconfirmed call (487, CANCEL, …). */
  onEarlyEnd?: (reason: string, options: EndOptions) => void;
  /** The first 2xx ACK: the call is up (inbound). */
  onAck?: () => void;
  onEnded?: (state: SipCallState) => void;
  private readonly posted = new Set<string>();
  private statusChain: Promise<void> = Promise.resolve();

  constructor(
    readonly host: CallHost,
    readonly callId: string,
    readonly trunk: Trunk,
    readonly direction: 'inbound' | 'outbound',
    readonly numbers: { from: string; to: string },
    readonly dialRequestId?: string,
  ) {
    this.createdAt = host.clock.now();
    this.timers = new TimerSet(host.clock);
    this.sessionTimer = new SessionTimer(host.clock, {
      refresh: () => void refreshSession(this),
      expire: () => this.end('session_expired', { bye: true, stream: 'stream-ended' }),
    });
  }

  armSessionTimer(seconds: number, weRefresh: boolean): void {
    this.sessionSeconds = seconds;
    this.sessionTimer.arm(seconds, weRefresh);
  }

  acked(): void {
    const onAck = this.onAck;
    this.onAck = undefined;
    onAck?.();
  }

  get logFields() {
    return {
      callId: this.callId,
      trunk: this.trunk.id,
      direction: this.direction,
      from: last4(this.numbers.from),
      to: last4(this.numbers.to),
    };
  }

  /**
   * Sends an in-dialog request through a client transaction and resolves its final response
   * (undefined on timeout). A 2xx to a re-INVITE is ACKed here, retransmissions included.
   */
  async sendInDialog(
    method: string,
    extra: [string, string][] = [],
    body?: Uint8Array,
  ): Promise<SipResponse | undefined> {
    const dialog = this.dialog;
    if (!dialog) return undefined;
    const request = dialog.request(method, extra, body);
    const flow = await this.inDialogFlow();
    if (!flow) return undefined;
    request.headers.prepend('via', this.host.via(flow.transport));
    request.headers.append('contact', this.host.contact(flow.transport));
    request.headers.append('user-agent', USER_AGENT);
    const seq = dialog.localSeq;
    return new Promise((resolve) => {
      this.host.transactions.request(request, flow, {
        onResponse: (response) => {
          if (response.status < 200) return;
          if (method === 'INVITE' && response.status < 300) {
            const ack = dialog.ack(seq);
            ack.headers.prepend('via', this.host.via(flow.transport));
            this.host.send(ack, flow);
          }
          resolve(response);
        },
        onTimeout: () => {
          this.host.counters.transactionTimeouts += 1;
          resolve(undefined);
        },
      });
    });
  }

  /** The flow to the dialog's next hop: the original flow when it is that hop, else a lookup. */
  async inDialogFlow(): Promise<Flow | undefined> {
    const { nextHop } = this.dialog!.route();
    const transport = nextHop.transport ?? this.flow?.transport ?? this.trunk.transport;
    const hopHost = /^sips?:(?:[^@]*@)?([^:;>]+)/.exec(nextHop.uri)?.[1];
    if (this.flow && hopHost === this.flow.address && transport === this.flow.transport)
      return this.flow;
    try {
      return await this.host.resolve(nextHop.uri, transport);
    } catch {
      return this.flow;
    }
  }

  /** Posts one status event (once per state), in order, to the call's status callback. */
  postStatus(
    state: SipCallState,
    extra: { sipCode?: number; reason?: string; payload?: Record<string, unknown> } = {},
  ): Promise<void> {
    if (!this.statusUrl || this.posted.has(state)) return this.statusChain;
    this.posted.add(state);
    let path: string;
    try {
      path = carrierPath(this.statusUrl);
    } catch {
      return this.statusChain;
    }
    const body = {
      v: 1,
      eventId: `${this.callId}:${state}`,
      callId: this.callId,
      ...(this.dialRequestId ? { dialRequestId: this.dialRequestId } : {}),
      state,
      occurredAt: new Date(this.host.clock.now()).toISOString(),
      ...extra,
    };
    this.statusChain = this.statusChain.then(() =>
      signedPostWithRetry(this.host.bridge, path, body).then(
        (reply) => {
          if (reply.status !== 200)
            this.host.logger.warn('sip.status_refused', {
              ...this.logFields,
              state,
              status: reply.status,
            });
        },
        (error: Error) =>
          this.host.logger.warn('sip.status_failed', {
            ...this.logFields,
            state,
            error: error.message,
          }),
      ),
    );
    return this.statusChain;
  }

  /** Tears the call down once: media, timers, BYE when asked, then the final status. */
  end(reason: string, options: EndOptions): void {
    if (this.phase === 'ending' || this.phase === 'ended') return;
    const wasConfirmed = this.phase === 'confirmed';
    this.phase = 'ending';
    this.endReason = reason;
    this.abort.abort();
    this.timers.stopAll();
    this.sessionTimer.stop();
    if (!wasConfirmed) this.onEarlyEnd?.(reason, options);
    const rtp: RtpStats | undefined = this.media?.stop(options.stream);
    if (!this.media && this.pair) this.host.pool.release(this.pair);
    const durationMs = this.answeredAt === undefined ? 0 : this.host.clock.now() - this.answeredAt;
    if (options.bye && wasConfirmed)
      void this.sendInDialog('BYE', [['Reason', NORMAL_CLEARING]]).catch(() => undefined);
    const state = options.state ?? (wasConfirmed ? 'completed' : 'failed');
    void this.postStatus(state, {
      ...(options.sipCode !== undefined ? { sipCode: options.sipCode } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
      payload: {
        endReason: reason,
        durationMs,
        ...(rtp ? { rtp } : {}),
        ...(this.codec ? { codec: this.codec } : {}),
        ...options.payload,
      },
    });
    this.host.counters.bump(this.host.counters.endings, reason);
    this.host.logger.info('sip.ended', {
      ...this.logFields,
      cause: reason,
      state,
      sipCode: options.sipCode,
      q850: q850Cause(options.reason),
      durationMs,
      codec: this.codec,
      rtp,
    });
    this.phase = 'ended';
    this.host.callEnded(this.callId);
    this.onEnded?.(state);
  }
}
