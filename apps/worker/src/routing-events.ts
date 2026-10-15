import {
  routingAgentRefs,
  type EventSink,
  type RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';

const log = createLogger({ service: 'worker' });

/** Session events the call inspector's Events tab also shows (transfer design 7.11). */
function mirrored(type: string): boolean {
  return (
    type.startsWith('route.') ||
    type.startsWith('transfer.') ||
    type.startsWith('segment.') ||
    type.startsWith('human.') ||
    type === 'disclosure'
  );
}

/**
 * A routed call segment's outcome events (routing design 7.4, 9.2). Every `route.*` event (and
 * R2's `transfer.*`, `segment.*` and `disclosure`) is also a telemetry audit, so the call
 * inspector's Events tab shows the route path; a callback promised in the segment names the
 * release that should dial back (`callback.releaseId`: the segment's agent, or for the router the
 * routing release's default target), unless the behaviour named one. A `disclosure` is stamped
 * with its segment, and a `route.decision` is logged as `route_decided`, ids and codes only.
 */
export function routeEventSink(
  events: EventSink | undefined,
  segment: {
    releaseId: string;
    telemetry: Pick<WorkerSessionTelemetry, 'audit'>;
    /** The segment's index, stamped on its disclosures (R2). */
    index?: number;
    /** The call, for the `route_decided` log line. */
    call?: { jobId: string; sessionId: string };
  },
): EventSink {
  return {
    async append(type, payload) {
      let stamped = withCallbackRelease(type, payload, segment.releaseId);
      if (type === 'disclosure' && segment.index !== undefined)
        stamped = { ...stamped, segment: segment.index };
      if (mirrored(type)) segment.telemetry.audit(type, stamped);
      if (type === 'route.decision') routeDecided(stamped, segment.call);
      await events?.append(type, stamped);
    },
    // No flush: the call's sink is sealed once, when the call ends, not when a segment does.
  };
}

/** R1 audit gap 7: the decision as one structured log line. */
function routeDecided(
  payload: Record<string, unknown>,
  call: { jobId: string; sessionId: string } | undefined,
): void {
  const pick = (key: string) => (typeof payload[key] === 'string' ? { [key]: payload[key] } : {});
  log.info('route_decided', {
    ...(call ?? {}),
    ...pick('routingReleaseId'),
    ...pick('target'),
    ...pick('agentId'),
    ...pick('releaseId'),
    ...pick('poolId'),
    ...pick('memberId'),
    ...pick('degraded'),
  });
}

function withCallbackRelease(
  type: string,
  payload: Record<string, unknown>,
  releaseId: string,
): Record<string, unknown> {
  const callback = payload.callback;
  if (type !== 'disposition' || !callback || typeof callback !== 'object') return payload;
  if (typeof (callback as { releaseId?: unknown }).releaseId === 'string') return payload;
  return { ...payload, callback: { ...callback, releaseId } };
}

/** Every agent a routed call can reach: whose transcript policy the call must honour. */
export function routedAgentIds(snapshot: RoutingReleaseSnapshot): string[] {
  const ids = new Set(routingAgentRefs(snapshot).map(({ ref }) => ref.agentId));
  for (const pool of Object.values(snapshot.pools))
    for (const member of pool.members) ids.add(member.agent.agentId);
  return [...ids];
}
