import { buildAnswer, negotiateOffer } from '../sdp/negotiate.ts';
import { SdpError, parseSdp } from '../sdp/parse.ts';
import { q850Cause } from '../sip/cause.ts';
import type { Flow } from '../sip/flow.ts';
import { ALLOWED_METHODS, parseCSeq, type SipRequest, type SipResponse } from '../sip/message.ts';
import { createResponse } from '../sip/serialize.ts';
import type { ServerTransaction } from '../sip/server-transaction.ts';
import { uasSessionTimer } from '../sip/session-timer.ts';
import type { Call } from './call.ts';

const SDP = 'application/sdp';
const DTMF_RELAY = /^Signal\s*=\s*([0-9*#A-D])\s*$/im;
const DTMF_DURATION = /^Duration\s*=\s*(\d{1,6})\s*$/im;

/**
 * Sends a 2xx and retransmits it (T1 doubling to T2, UDP only) until the ACK arrives; after
 * 64·T1 without one, `onTimeout` (RFC 3261 §13.3.1.4, RFC 6026 Timer L).
 */
export function sendReliable2xx(
  call: Call,
  tx: ServerTransaction,
  response: SipResponse,
  onTimeout: () => void,
) {
  const { t1, t2 } = call.host.config.timers;
  const seq = parseCSeq(tx.request.headers.get('cseq'))?.seq;
  call.awaitingAck = seq;
  tx.respond(response);
  const resend = (interval: number) =>
    call.timers.start('2xx', interval, () => {
      if (call.awaitingAck !== seq) return;
      call.host.send(response, tx.flow);
      resend(Math.min(interval * 2, t2));
    });
  if (tx.flow.transport === 'udp') resend(t1);
  call.timers.start('ack', 64 * t1, () => {
    if (call.awaitingAck === seq) onTimeout();
  });
}

function respond(
  tx: ServerTransaction | undefined,
  request: SipRequest,
  status: number,
  call: Call,
  extra: [string, string][] = [],
) {
  tx?.respond(createResponse(request, status, { toTag: call.dialog?.localTag, headers: extra }));
}

/** A re-INVITE: hold/unhold or codec change within the profile, glare → 491, refusal → 488. */
function reInvite(call: Call, request: SipRequest, tx: ServerTransaction): void {
  if (call.awaitingAck !== undefined || call.refreshing)
    return respond(tx, request, 491, call, [['Retry-After', '1']]);
  const timer = uasSessionTimer(request);
  if (timer.kind === 'reject')
    return respond(tx, request, 422, call, [['Min-SE', String(timer.minSe)]]);
  let answer = call.answer;
  if (request.body.length) {
    try {
      const offer = parseSdp(request.body);
      const result = negotiateOffer(offer, call.trunk.codecs);
      if (!result.ok) return respond(tx, request, 488, call);
      call.media?.update(result.choice);
      call.codec = result.choice.codec;
      answer = buildAnswer(offer, result.choice, call.localMedia!, call.origin);
      call.answer = answer;
    } catch (error) {
      if (error instanceof SdpError) return respond(tx, request, 488, call);
      throw error;
    }
  }
  if (timer.kind === 'timer') call.armSessionTimer(timer.seconds, timer.refresher === 'uas');
  const response = createResponse(request, 200, {
    toTag: call.dialog!.localTag,
    headers: [
      ['Contact', call.host.contact(tx.flow.transport)],
      ['Supported', 'timer'],
      ...(timer.kind === 'timer' ? timer.headers : []),
      ...(answer ? ([['Content-Type', SDP]] as [string, string][]) : []),
    ],
    ...(answer ? { body: Buffer.from(answer) } : {}),
  });
  sendReliable2xx(call, tx, response, () =>
    call.end('ack_timeout', { bye: true, stream: 'stream-ended' }),
  );
}

/** Requests inside a confirmed (or early, for BYE/CANCEL races) dialog. */
export function inDialog(
  call: Call,
  request: SipRequest,
  flow: Flow,
  tx?: ServerTransaction,
): void {
  const dialog = call.dialog!;
  if (request.method === 'ACK') {
    const seq = parseCSeq(request.headers.get('cseq'))?.seq;
    if (seq !== undefined && seq === call.awaitingAck) {
      call.awaitingAck = undefined;
      call.timers.stop('2xx');
      call.timers.stop('ack');
      call.acked();
    }
    return;
  }
  if (!dialog.acceptRemoteSeq(request)) return respond(tx, request, 500, call);
  switch (request.method) {
    case 'BYE':
      respond(tx, request, 200, call);
      return call.end('remote_bye', {
        bye: false,
        stream: 'caller-hangup',
        ...(request.headers.get('reason') ? { reason: request.headers.get('reason') } : {}),
      });
    case 'INVITE':
      return reInvite(call, request, tx!);
    case 'UPDATE': {
      // Session refresh only: an offer in UPDATE is outside the profile.
      if (request.body.length) return respond(tx, request, 488, call);
      const timer = uasSessionTimer(request);
      if (timer.kind === 'reject')
        return respond(tx, request, 422, call, [['Min-SE', String(timer.minSe)]]);
      if (timer.kind === 'timer') call.armSessionTimer(timer.seconds, timer.refresher === 'uas');
      return respond(tx, request, 200, call, timer.kind === 'timer' ? timer.headers : []);
    }
    case 'INFO': {
      const type = request.headers.get('content-type')?.toLowerCase() ?? '';
      if (!type.startsWith('application/dtmf-relay'))
        return respond(tx, request, 415, call, [['Accept', 'application/dtmf-relay']]);
      const text = Buffer.from(request.body).toString('utf8');
      const digit = DTMF_RELAY.exec(text)?.[1];
      if (!digit) return respond(tx, request, 400, call);
      const duration = DTMF_DURATION.exec(text)?.[1];
      call.media?.dtmf(digit, duration ? Number(duration) : undefined);
      return respond(tx, request, 200, call);
    }
    case 'OPTIONS':
      return respond(tx, request, 200, call, [
        ['Allow', ALLOWED_METHODS.join(', ')],
        ['Accept', SDP],
      ]);
    default:
      return respond(tx, request, 405, call, [['Allow', ALLOWED_METHODS.join(', ')]]);
  }
}

/** Logged on every BYE we receive: the Q.850 cause when the far end gave one. */
export function byeCause(request: SipRequest): number | undefined {
  return q850Cause(request.headers.get('reason'));
}

/** Our session refresh as the refresher: a re-INVITE carrying our current SDP unchanged. */
export async function refreshSession(call: Call): Promise<void> {
  if (call.phase !== 'confirmed' || call.refreshing) return;
  call.refreshing = true;
  try {
    const body = call.answer ? Buffer.from(call.answer) : undefined;
    const response = await call.sendInDialog(
      'INVITE',
      [
        ['Supported', 'timer'],
        [
          'Session-Expires',
          `${call.sessionSeconds};refresher=${call.direction === 'inbound' ? 'uas' : 'uac'}`,
        ],
        ...(body ? ([['Content-Type', SDP]] as [string, string][]) : []),
      ],
      body,
    );
    if (!response || response.status === 408 || response.status === 481)
      return call.end('session_refresh_failed', { bye: true, stream: 'stream-ended' });
    call.armSessionTimer(call.sessionSeconds, true);
  } finally {
    call.refreshing = false;
  }
}
