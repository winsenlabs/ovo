import type { SipDialRequest } from '@winsendotai/ovo-sip-carrier-kit';
import { acceptAnswer, buildOffer, type MediaChoice } from '../sdp/negotiate.ts';
import { parseSdp } from '../sdp/parse.ts';
import { finalToState, retryAfterSeconds } from '../sip/cause.ts';
import type { ClientTransaction } from '../sip/client-transaction.ts';
import { Dialog, tagOf } from '../sip/dialog.ts';
import { pickChallenge } from '../sip/digest.ts';
import type { Flow } from '../sip/flow.ts';
import type { SipRequest, SipResponse } from '../sip/message.ts';
import { parseSessionExpires } from '../sip/session-timer.ts';
import { authorizedInvite, cancelFor, initialInvite } from '../sip/uac-requests.ts';
import type { Call } from './call.ts';
import type { CallHost } from './host.ts';
import { mediaForCall } from './media.ts';

export const DEFAULT_RING_TIMEOUT_SEC = 60;
/** A trunk gets at most this many digest rounds per call (a stale nonce allows the second). */
const MAX_AUTH_ROUNDS = 2;

/**
 * What a leg needs to dial. A worker's dial is the whole `SipDialRequest`; a bridged handoff has no
 * media socket or status callback, so it names only these fields plus how to address the INVITE.
 */
export type LegRequest = Pick<
  SipDialRequest,
  'requestId' | 'ringTimeoutSec' | 'maxDurationSec' | 'credentials'
> &
  Partial<Pick<SipDialRequest, 'media' | 'callbacks'>> & {
    invite?: { requestUri?: string; headers?: [string, string][] };
  };

/** The UAC side of one outbound call: INVITE, digest, ring timeout, CANCEL, answer, forks. */
export class OutboundLeg {
  private invite?: SipRequest;
  private transaction?: ClientTransaction;
  private flow?: Flow;
  private provisional = false;
  private cancelWanted = false;
  private cancelSent = false;
  private authRounds = 0;
  private readonly nonces = new Set<string>();
  private lastAck?: SipRequest;

  constructor(
    private readonly host: CallHost,
    private readonly call: Call,
    private readonly request: LegRequest,
    /** Set for a bridged leg: told when it is answered instead of opening a media socket. */
    private readonly onAnswered?: (choice: MediaChoice, response: SipResponse) => void,
  ) {}

  async start(): Promise<void> {
    const { call, host, request } = this;
    const proxy = call.trunk.outbound.proxy!;
    call.onEarlyEnd = () => this.cancel();
    call.timers.start('ring', (request.ringTimeoutSec ?? DEFAULT_RING_TIMEOUT_SEC) * 1000, () =>
      call.end('ring_timeout', { bye: false, stream: 'gateway', state: 'no_answer' }),
    );
    try {
      this.flow = await host.resolve(proxy, call.trunk.transport);
    } catch {
      return call.end('proxy_unresolvable', {
        bye: false,
        stream: 'gateway',
        state: 'failed',
        payload: { retryable: true },
      });
    }
    if (call.phase !== 'early') return;
    call.localMedia = { address: host.config.advertisedHost, port: call.pair!.port };
    call.answer = buildOffer(call.trunk.codecs, call.localMedia, call.origin);
    this.send(
      initialInvite({
        proxy,
        ...call.numbers,
        callId: call.callId,
        advertisedHost: host.config.advertisedHost,
        via: host.via(this.flow.transport),
        contact: host.contact(this.flow.transport),
        sdp: call.answer,
        ...(this.request.invite?.requestUri ? { requestUri: this.request.invite.requestUri } : {}),
        ...(this.request.invite?.headers ? { extraHeaders: this.request.invite.headers } : {}),
      }),
    );
  }

  private send(invite: SipRequest): void {
    this.invite = invite;
    this.transaction = this.host.transactions.request(invite, this.flow!, {
      onResponse: (response) => this.onResponse(invite, response),
      onTimeout: () => {
        if (invite !== this.invite) return;
        this.host.counters.transactionTimeouts += 1;
        this.call.end('invite_timeout', {
          bye: false,
          stream: 'gateway',
          state: 'failed',
          sipCode: 408,
          payload: { retryable: true },
        });
      },
    });
  }

  private onResponse(invite: SipRequest, response: SipResponse): void {
    if (invite !== this.invite) return;
    const { call } = this;
    if (response.status < 200) {
      this.provisional = true;
      if (this.cancelWanted) this.sendCancel();
      if (call.phase === 'early' && (response.status === 180 || response.status === 183)) {
        this.host.registry.record(this.request.requestId, {
          kind: 'live',
          carrierCallId: call.callId,
          state: 'ringing',
        });
        void call.postStatus('ringing', { sipCode: response.status });
      }
      return;
    }
    if (response.status < 300) return this.onAnswer(response);
    if ((response.status === 401 || response.status === 407) && this.retryWithAuth(response))
      return;
    if (call.phase !== 'early') return;
    const mapped = finalToState(response.status);
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
    call.end(`sip_${response.status}`, {
      bye: false,
      stream: 'gateway',
      state: mapped.state,
      sipCode: response.status,
      ...(response.headers.get('reason') ? { reason: response.headers.get('reason') } : {}),
      payload: {
        retryable: mapped.retryable,
        ...(retryAfter !== undefined ? { retryAfterSec: retryAfter } : {}),
      },
    });
  }

  /** One digest round per challenge, a fresh nonce each time (a stale nonce allows a second). */
  private retryWithAuth(response: SipResponse): boolean {
    const credentials = this.request.credentials;
    const proxyAuth = response.status === 407;
    const challenge = pickChallenge(
      response.headers.values(proxyAuth ? 'proxy-authenticate' : 'www-authenticate'),
    );
    if (
      !credentials ||
      !challenge ||
      this.call.phase !== 'early' ||
      this.authRounds >= MAX_AUTH_ROUNDS ||
      this.nonces.has(challenge.nonce) ||
      (this.authRounds > 0 && !challenge.stale)
    )
      return false;
    this.authRounds += 1;
    this.nonces.add(challenge.nonce);
    this.send(
      authorizedInvite(this.invite!, {
        via: this.host.via(this.flow!.transport),
        proxyAuth,
        challenge,
        ...credentials,
      }),
    );
    return true;
  }

  private onAnswer(response: SipResponse): void {
    const { call, host } = this;
    const existing = call.dialog;
    if (existing && tagOf(response.headers.get('to')) === existing.remoteTag) {
      // A retransmitted 2xx: the ACK went missing.
      if (this.lastAck) host.send(this.lastAck, call.flow ?? this.flow!);
      return;
    }
    const dialog = Dialog.asUac(this.invite!, response);
    const ack = this.ack(dialog);
    if (existing || call.phase !== 'early') {
      // A forked 2xx, or an answer that raced our CANCEL / hangup: ACK, then BYE that dialog.
      const bye = dialog.request('BYE');
      bye.headers.prepend('via', host.via(this.flow!.transport));
      host.transactions.request(bye, this.flow!, {
        onResponse: () => undefined,
        onTimeout: () => undefined,
      });
      return;
    }
    this.lastAck = ack;
    call.dialog = dialog;
    call.flow = this.flow;
    let choice: MediaChoice | undefined;
    try {
      const negotiated = acceptAnswer(parseSdp(response.body), call.trunk.codecs);
      choice = negotiated.ok ? negotiated.choice : undefined;
    } catch {
      choice = undefined;
    }
    call.timers.stop('ring');
    call.phase = 'confirmed';
    call.answeredAt = host.clock.now();
    if (!choice)
      return call.end('answer_unacceptable', { bye: true, stream: 'gateway', state: 'failed' });
    this.connect(choice, response);
  }

  private ack(dialog: Dialog): SipRequest {
    const ack = dialog.ack(Number(this.invite!.headers.get('cseq')!.split(' ')[0]));
    ack.headers.prepend('via', this.host.via(this.flow!.transport));
    this.host.send(ack, this.flow!);
    return ack;
  }

  private connect(choice: MediaChoice, response: SipResponse): void {
    const { call, host, request } = this;
    call.codec = choice.codec;
    const se = parseSessionExpires(response.headers.get('session-expires'));
    if (se) call.armSessionTimer(se.seconds, (se.refresher ?? 'uac') === 'uac');
    call.timers.start('max', request.maxDurationSec * 1000, () =>
      call.end('max_duration', { bye: true, stream: 'stream-ended' }),
    );
    if (this.onAnswered) return this.onAnswered(choice, response);
    host.registry.record(request.requestId, {
      kind: 'live',
      carrierCallId: call.callId,
      state: 'in_progress',
    });
    void call.postStatus('in_progress', { sipCode: response.status });
    call.media = mediaForCall(host, call, choice, {
      mediaUrl: request.media!.url,
      routeParams: request.media!.routeParams,
      statusUrl: request.callbacks!.status,
      ...(request.callbacks!.resume ? { resumeUrl: request.callbacks!.resume } : {}),
    });
    const media = call.media;
    media.start();
    media.connect().catch((error: Error) => {
      host.logger.warn('sip.media_connect_failed', { ...call.logFields, error: error.message });
      call.end('media_connect_failed', { bye: true, stream: 'gateway', state: 'failed' });
    });
  }

  /** CANCEL needs a provisional first (RFC 3261 §9.1); until then it is only wanted. */
  cancel(): void {
    this.cancelWanted = true;
    if (this.provisional) this.sendCancel();
  }

  private sendCancel(): void {
    const invite = this.invite;
    if (this.cancelSent || !invite) return;
    this.cancelSent = true;
    const cancel = cancelFor(invite);
    this.host.transactions.request(cancel, this.flow!, {
      onResponse: () => undefined,
      onTimeout: () => undefined,
    });
    this.transaction?.cancelled();
  }
}
