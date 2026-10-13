import { SIP_MAX_FORWARDED_HEADERS, SIP_MAX_HEADER_VALUE } from '@winsendotai/ovo-sip-carrier-kit';
import { admit, type StreamGrant } from '../bridge/admission.ts';
import { trunkForSource, type Trunk } from '../config/trunks.ts';
import { normaliseNumber, userOf } from '../policy/numbers.ts';
import { buildAnswer, negotiateOffer, type MediaChoice } from '../sdp/negotiate.ts';
import { SdpError, parseSdp, type Sdp } from '../sdp/parse.ts';
import { Dialog } from '../sip/dialog.ts';
import type { Flow } from '../sip/flow.ts';
import { ALLOWED_METHODS, type SipRequest } from '../sip/message.ts';
import { createResponse, newTag } from '../sip/serialize.ts';
import type { ServerTransaction } from '../sip/server-transaction.ts';
import { uasSessionTimer, type UasTimerDecision } from '../sip/session-timer.ts';
import { Call } from './call.ts';
import type { CallHost } from './host.ts';
import { sendReliable2xx } from './in-dialog.ts';
import { mediaForCall } from './media.ts';

const SDP = 'application/sdp';

/** The headers named in the trunk's `forwardHeaders`, names as configured, values capped (§5.2). */
export function forwardedHeaders(invite: SipRequest, trunk: Trunk): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of trunk.forwardHeaders.slice(0, SIP_MAX_FORWARDED_HEADERS)) {
    const value = invite.headers.get(name);
    if (value !== undefined) out[name] = value.slice(0, SIP_MAX_HEADER_VALUE);
  }
  return out;
}

/** The caller as E.164 from P-Asserted-Identity, else From; 'anonymous' when neither normalises. */
export function callerOf(invite: SipRequest, trunk: Trunk): string {
  for (const header of [invite.headers.get('p-asserted-identity'), invite.headers.get('from')]) {
    const user = userOf(header);
    const number = user ? normaliseNumber(user, trunk.numberFormat.country) : undefined;
    if (number) return number;
  }
  return 'anonymous';
}

interface Offer {
  sdp: Sdp;
  choice: MediaChoice;
  timer: UasTimerDecision;
}

/** Everything that refuses an INVITE before a call exists, as a final status (or the offer). */
function screen(host: CallHost, invite: SipRequest, trunk?: Trunk): number | Offer {
  if (!trunk || !trunk.inbound.enabled) return 403;
  if (!host.trunkRate(trunk)) return 503;
  const timer = uasSessionTimer(invite);
  if (timer.kind === 'reject') return 422;
  const to = normaliseNumber(userOf(invite.uri) ?? '', trunk.numberFormat.country);
  if (!to || !trunk.inbound.numbers.includes(to)) return 404;
  if (host.registry.get(invite.headers.get('call-id'))) return 482;
  if (
    host.registry.size >= host.config.maxCalls ||
    host.registry.onTrunk(trunk.id) >= trunk.maxConcurrent
  )
    return 503;
  if (!(invite.headers.get('content-type') ?? '').toLowerCase().startsWith(SDP)) return 488;
  try {
    const sdp = parseSdp(invite.body);
    const negotiated = negotiateOffer(sdp, trunk.codecs);
    return negotiated.ok ? { sdp, choice: negotiated.choice, timer } : 488;
  } catch (error) {
    if (error instanceof SdpError) return 488;
    throw error;
  }
}

/**
 * A new INVITE from a trunk (§3 inbound path): screen it, ring, ask the host for admission
 * (following `wait`), open the carrier socket, then answer with SDP and wait for the ACK.
 */
export async function handleInvite(
  host: CallHost,
  invite: SipRequest,
  flow: Flow,
  tx: ServerTransaction,
): Promise<void> {
  if (host.draining)
    return tx.respond(createResponse(invite, 503, { headers: [['Retry-After', '30']] }));
  const trunk = trunkForSource(host.config.trunks, flow.address);
  const screened = screen(host, invite, trunk);
  if (typeof screened === 'number') {
    host.counters.bump(host.counters.decisions, `refused_${screened}`);
    const headers: [string, string][] =
      screened === 503
        ? [['Retry-After', '5']]
        : screened === 422
          ? [['Min-SE', String((uasSessionTimer(invite) as { minSe: number }).minSe)]]
          : [];
    return tx.respond(createResponse(invite, screened, { headers }));
  }
  const { sdp, choice, timer } = screened;
  const inboundTrunk = trunk!;
  const callId = invite.headers.get('call-id')!;
  const to = normaliseNumber(userOf(invite.uri)!, inboundTrunk.numberFormat.country)!;
  const call = new Call(host, callId, inboundTrunk, 'inbound', {
    from: callerOf(invite, inboundTrunk),
    to,
  });
  const localTag = newTag();
  host.registry.add(call);
  host.counters.invites += 1;
  tx.respond(createResponse(invite, 100));
  host.logger.info('sip.invite', call.logFields);
  call.onEarlyEnd = (_reason, options) => {
    if (!tx.finished)
      tx.respond(createResponse(invite, options.sipCode ?? 487, { toTag: localTag }));
  };
  const pair = await host.pool.acquire();
  if (call.phase !== 'early') {
    if (pair) host.pool.release(pair);
    return;
  }
  if (!pair) return call.end('rtp_exhausted', { bye: false, stream: 'gateway', sipCode: 503 });
  call.pair = pair;
  tx.respond(
    createResponse(invite, 180, {
      toTag: localTag,
      headers: [['Contact', host.contact(flow.transport)]],
    }),
  );
  const outcome = await admit({
    target: host.bridge,
    carrierId: inboundTrunk.carrierId,
    bindingId: inboundTrunk.bindingId,
    request: {
      callId,
      trunkId: inboundTrunk.id,
      from: call.numbers.from,
      to,
      receivedAt: new Date(call.createdAt).toISOString(),
      headers: forwardedHeaders(invite, inboundTrunk),
      sip: {
        requestUri: invite.uri,
        fromUri: invite.headers.get('from') ?? '',
        ...(invite.headers.get('p-asserted-identity')
          ? { pAssertedIdentity: invite.headers.get('p-asserted-identity')! }
          : {}),
      },
    },
    waitMaxMs: host.config.inboundWaitMaxMs,
    now: () => host.clock.now(),
    sleep: (ms, signal) => host.sleep(ms, signal),
    signal: call.abort.signal,
  });
  host.counters.bump(
    host.counters.decisions,
    outcome.kind === 'connect' ? 'connect' : outcome.reason,
  );
  host.logger.info('sip.admission', {
    ...call.logFields,
    decision: outcome.kind === 'connect' ? 'connect' : outcome.reason,
    ms: outcome.decisionMs,
  });
  if (call.phase !== 'early') {
    // Cancelled while the host decided: tell it the admitted call is gone.
    if (outcome.kind === 'connect' && outcome.grant.statusUrl) {
      call.statusUrl = outcome.grant.statusUrl;
      void call.postStatus('canceled', { payload: { endReason: call.endReason } });
    }
    return;
  }
  if (outcome.kind === 'refuse')
    return call.end(`admission_${outcome.reason}`, {
      bye: false,
      stream: 'gateway',
      sipCode: outcome.status,
    });
  await answer(host, call, {
    invite,
    flow,
    tx,
    sdp,
    choice,
    timer,
    localTag,
    grant: outcome.grant,
  });
}

async function answer(
  host: CallHost,
  call: Call,
  input: Offer & {
    invite: SipRequest;
    flow: Flow;
    tx: ServerTransaction;
    localTag: string;
    grant: StreamGrant;
  },
): Promise<void> {
  call.statusUrl = input.grant.statusUrl;
  call.localMedia = { address: host.config.advertisedHost, port: call.pair!.port };
  call.codec = input.choice.codec;
  call.media = mediaForCall(host, call, input.choice, input.grant);
  try {
    await call.media.connect();
  } catch (error) {
    host.logger.warn('sip.media_connect_failed', {
      ...call.logFields,
      error: (error as Error).message,
    });
    return call.end('media_connect_failed', { bye: false, stream: 'gateway', sipCode: 503 });
  }
  if (call.phase !== 'early') return;
  call.answer = buildAnswer(input.sdp, input.choice, call.localMedia, call.origin);
  call.dialog = Dialog.asUas(input.invite, input.localTag);
  call.flow = input.flow;
  call.phase = 'confirmed';
  call.answeredAt = host.clock.now();
  call.media.start();
  if (input.timer.kind === 'timer')
    call.armSessionTimer(input.timer.seconds, input.timer.refresher === 'uas');
  const ok = createResponse(input.invite, 200, {
    toTag: input.localTag,
    headers: [
      ['Contact', host.contact(input.flow.transport)],
      ['Allow', ALLOWED_METHODS.join(', ')],
      ['Supported', 'timer'],
      ...(input.timer.kind === 'timer' ? input.timer.headers : []),
      ['Content-Type', SDP],
    ],
    body: Buffer.from(call.answer),
  });
  call.onAck = () => host.logger.info('sip.answered', { ...call.logFields, codec: call.codec });
  sendReliable2xx(call, input.tx, ok, () =>
    call.end('ack_timeout', { bye: true, stream: 'stream-ended' }),
  );
  void call.postStatus('in_progress');
}
