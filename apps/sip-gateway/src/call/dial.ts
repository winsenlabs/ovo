import { randomUUID } from 'node:crypto';
import type { SipDialRequest, SipDialResponse } from '@winsendotai/ovo-sip-carrier-kit';
import type { Trunk } from '../config/trunks.ts';
import { allowedDestination } from '../policy/numbers.ts';
import { Call } from './call.ts';
import type { CallHost } from './host.ts';
import { OutboundLeg } from './outbound-leg.ts';

export type DialRefusal = { status: 422 | 503; reason: string; retryable: boolean };

/** The §4.7 / §5.4 checks on `POST /v1/calls`; the trunk when the dial may go ahead. */
export function checkDial(host: CallHost, request: SipDialRequest): Trunk | DialRefusal {
  const refuse = (status: 422 | 503, reason: string): DialRefusal => ({
    status,
    reason,
    retryable: status === 503,
  });
  if (host.draining) return refuse(503, 'draining');
  const trunk = host.config.trunks.find((t) => t.id === request.trunkId);
  if (!trunk) return refuse(422, 'unknown_trunk');
  if (!trunk.outbound.enabled || !trunk.outbound.proxy) return refuse(422, 'outbound_disabled');
  if (trunk.carrierId !== request.carrierId || trunk.bindingId !== request.bindingId)
    return refuse(422, 'binding_mismatch');
  if (
    !trunk.outbound.fromNumbers.includes(request.from) ||
    !host.config.permittedFromNumbers.includes(request.from)
  )
    return refuse(422, 'from_not_permitted');
  if (!allowedDestination(request.to, host.config.countryAllowlist))
    return refuse(422, 'destination_not_permitted');
  if (new URL(request.media.url).search) return refuse(422, 'media_url_has_query');
  if (trunk.outbound.auth === 'digest' && !request.credentials)
    return refuse(422, 'credentials_required');
  if (
    host.registry.size >= host.config.maxCalls ||
    host.registry.onTrunk(trunk.id) >= trunk.maxConcurrent
  )
    return refuse(503, 'at_capacity');
  if (!host.trunkRate(trunk)) return refuse(503, 'rate_limited');
  return trunk;
}

/**
 * `POST /v1/calls` once checked: mint the Call-ID, reserve RTP, answer `accepted` at once
 * (`callIdTiming: 'at-dial'`) and send the INVITE in the background. A repeated requestId gets
 * the same answer again.
 */
export async function dial(
  host: CallHost,
  request: SipDialRequest,
  trunk: Trunk,
): Promise<{ status: number; body: SipDialResponse }> {
  const known = host.registry.reconcile(request.requestId);
  if (known.kind === 'live' || known.kind === 'ended')
    return {
      status: 200,
      body: {
        kind: 'accepted',
        carrierCallId: known.carrierCallId,
        carrierRequestId: request.requestId,
      },
    };
  const pair = await host.pool.acquire();
  if (!pair)
    return { status: 503, body: { kind: 'rejected', reason: 'at_capacity', retryable: true } };
  const callId = `${randomUUID()}@${host.config.advertisedHost}`;
  const call = new Call(
    host,
    callId,
    trunk,
    'outbound',
    { from: request.from, to: request.to },
    request.requestId,
  );
  call.pair = pair;
  call.statusUrl = request.callbacks.status;
  call.onEnded = (state) =>
    host.registry.record(request.requestId, {
      kind: 'ended',
      carrierCallId: callId,
      state: state === 'ringing' || state === 'in_progress' ? 'completed' : state,
    });
  host.registry.add(call);
  host.registry.record(request.requestId, { kind: 'live', carrierCallId: callId, state: 'queued' });
  host.counters.outboundDials += 1;
  void new OutboundLeg(host, call, request).start();
  host.logger.info('sip.outbound', {
    ...call.logFields,
    requestId: request.requestId,
    result: 'accepted',
  });
  return {
    status: 200,
    body: { kind: 'accepted', carrierCallId: callId, carrierRequestId: request.requestId },
  };
}
