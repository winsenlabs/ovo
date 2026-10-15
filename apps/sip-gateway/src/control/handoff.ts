import type { SipHandoffRequest, SipHandoffResponse } from '@winsendotai/ovo-sip-carrier-kit';
import { requestRefer } from '../call/refer.ts';
import { referTarget } from '../policy/refer-target.ts';
import type { SipGateway } from '../gateway.ts';

const reject = (reason: string, retryable = false): SipHandoffResponse => ({
  kind: 'rejected',
  reason,
  retryable,
});

/**
 * `POST /v1/calls/handoff`: transfer the caller's leg away with an in-dialog REFER. The trunk file
 * is the gate (`refer.enabled`), checked before anything is built or sent. A repeated `requestId`
 * returns what the first attempt found, so a worker retry after a lost response does not look
 * for a call that already left.
 */
export async function handoff(
  gateway: SipGateway,
  request: SipHandoffRequest,
): Promise<SipHandoffResponse> {
  const { registry } = gateway;
  const remembered = registry.handoffFor(request.requestId);
  if (remembered) return remembered;
  const call = registry.get(request.carrierCallId);
  if (!call || call.phase === 'ending' || call.phase === 'ended') return reject('call_not_found');
  if (call.phase !== 'confirmed') return reject('call_not_confirmed', true);
  const { trunk } = call;
  if (!trunk.refer.enabled) return reject('refer_not_enabled');
  const target = referTarget(trunk, request.target);
  if (!target.ok) return reject(target.reason);
  const result = await requestRefer(call, {
    requestId: request.requestId,
    referTo: target.referTo,
    host: target.host,
  });
  if (result.kind !== 'rejected') registry.rememberHandoff(request.requestId, result);
  return result;
}
