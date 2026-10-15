import type { RouteLines, RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';

/**
 * What the router reads of a release's human queues (human queue design 7.6). The routing
 * snapshot pins each bound queue by value under `queues` (schema 3, keyed by queue id, the
 * binding key inside); a release that binds none has no such record, and its `human` steps stay
 * skipped as in R2.
 */
interface BoundQueue {
  key: string;
  definition: { announcement?: RouteLines };
}

function boundQueues(snapshot: RoutingReleaseSnapshot): BoundQueue[] {
  const queues = (snapshot as { queues?: Record<string, BoundQueue> }).queues;
  return queues ? Object.values(queues) : [];
}

/** The queue a `human` target or step names by its binding key, when the release binds it. */
export function boundQueue(
  snapshot: RoutingReleaseSnapshot,
  key: string,
): { announcement?: RouteLines } | undefined {
  return boundQueues(snapshot).find((queue) => queue.key === key)?.definition;
}
