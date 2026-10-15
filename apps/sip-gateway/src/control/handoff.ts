import type { SipHandoffRequest, SipHandoffResponse } from '@winsendotai/ovo-sip-carrier-kit';
import { startBridge } from '../call/bridge.ts';
import type { Call } from '../call/call.ts';
import { requestRefer } from '../call/refer.ts';
import { bridgeTarget, referTarget } from '../policy/refer-target.ts';
import type { SipGateway } from '../gateway.ts';

const reject = (reason: string, retryable = false): SipHandoffResponse => ({
  kind: 'rejected',
  reason,
  retryable,
});

/** The caller-ID for a bridged leg: the number the caller dialled when the trunk may send it. */
function bridgeFrom(gateway: SipGateway, call: Call): string | undefined {
  const permitted = (number: string) =>
    call.trunk.outbound.fromNumbers.includes(number) &&
    gateway.config.permittedFromNumbers.includes(number);
  return [call.numbers.to, ...call.trunk.outbound.fromNumbers].find(permitted);
}

/** Stretch S1: relay instead of REFER, for a trunk whose `refer.mode` is `bridge`. */
async function bridged(
  gateway: SipGateway,
  call: Call,
  request: SipHandoffRequest,
): Promise<SipHandoffResponse> {
  if (!gateway.config.bridgeEnabled) return reject('bridge_not_enabled');
  if (call.bridge)
    return call.bridge.requestId === request.requestId
      ? call.bridge.done
      : reject('refer_in_progress', true);
  if (call.refer) return reject('refer_in_progress', true);
  const target = bridgeTarget(call.trunk, request.target, gateway.config.countryAllowlist);
  if (!target.ok) return reject(target.reason);
  const from = bridgeFrom(gateway, call);
  if (!from) return reject('bridge_from_not_permitted');
  if (
    gateway.draining ||
    gateway.registry.size >= gateway.config.maxCalls ||
    gateway.registry.onTrunk(call.trunk.id) >= call.trunk.maxConcurrent
  )
    return reject('bridge_at_capacity', true);
  const result = await startBridge(gateway, call, {
    requestId: request.requestId,
    target: target.target,
    from,
  });
  if (result.kind !== 'rejected') gateway.registry.rememberHandoff(request.requestId, result);
  return result;
}

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
  if (trunk.refer.mode === 'bridge') return bridged(gateway, call, request);
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
