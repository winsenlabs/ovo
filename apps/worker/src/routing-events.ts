import {
  routingAgentRefs,
  type EventSink,
  type RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';

/**
 * A routed call segment's outcome events (routing design 7.4, 9.2). Every `route.*` event is also a
 * telemetry audit, so the call inspector's Events tab shows the route path; a callback promised in
 * the segment names the release that should dial back (`callback.releaseId`: the segment's agent,
 * or for the router the routing release's default target), unless the behaviour named one.
 */
export function routeEventSink(
  events: EventSink | undefined,
  segment: { releaseId: string; telemetry: Pick<WorkerSessionTelemetry, 'audit'> },
): EventSink {
  return {
    async append(type, payload) {
      const stamped = withCallbackRelease(type, payload, segment.releaseId);
      if (type.startsWith('route.')) segment.telemetry.audit(type, stamped);
      await events?.append(type, stamped);
    },
    // No flush: the call's sink is sealed once, when the call ends, not when a segment does.
  };
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
