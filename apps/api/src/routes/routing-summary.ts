import {
  routingPoolIds,
  type RoutingPoint,
  type RoutingPointSummary,
  type RoutingRelease,
  type RoutingReleaseSummary,
} from '@winsendotai/ovo-contracts';
import type { OperationsService, RoutingService } from '@winsendotai/ovo-plugin-operations';

/** Numbers are read a page at a time; a workspace this big is not one an overview needs counted. */
const NUMBER_PAGES = 20;

/** Inbound numbers pinned to each routing point and to each routing release, in one walk. */
export async function pinnedNumbers(operations: Pick<OperationsService, 'inboundRoutes'>) {
  const byPoint = new Map<string, number>();
  const byRelease = new Map<string, number>();
  let after: string | undefined;
  for (let page = 0; page < NUMBER_PAGES; page += 1) {
    const routes = await operations.inboundRoutes.list(100, after);
    for (const route of routes) {
      if (!route.routing || !route.routingReleaseId) continue;
      byPoint.set(route.routing.pointId, (byPoint.get(route.routing.pointId) ?? 0) + 1);
      byRelease.set(route.routingReleaseId, (byRelease.get(route.routingReleaseId) ?? 0) + 1);
    }
    if (routes.length < 100) break;
    after = routes.at(-1)!.phoneNumber;
  }
  return { byPoint, byRelease };
}

/** What the points list shows beside each point, from one query for releases and one walk of numbers. */
export async function withPointSummaries(
  routing: Pick<RoutingService, 'releases'>,
  operations: Pick<OperationsService, 'inboundRoutes'>,
  points: readonly RoutingPoint[],
): Promise<(RoutingPoint & { summary: RoutingPointSummary })[]> {
  const [latest, numbers] = await Promise.all([
    routing.releases.latest(points.map((point) => point.id)),
    pinnedNumbers(operations),
  ]);
  return points.map((point) => {
    const release = latest.get(point.id) ?? null;
    return {
      ...point,
      summary: {
        nodes: point.draft.nodes.length,
        pools: routingPoolIds(point.draft).length,
        languages: point.draft.language.allowed,
        humanQueues: point.draft.humanQueues?.length ?? 0,
        latestRelease: release,
        published: release !== null && release.draftVersion === point.draftVersion,
        numbers: numbers.byPoint.get(point.id) ?? 0,
      },
    };
  });
}

/** A release list row without its snapshot. */
export function releaseSummaries(
  releases: readonly RoutingRelease[],
  numbers: Map<string, number>,
): RoutingReleaseSummary[] {
  return releases.map((release) => ({
    id: release.id,
    routingPointId: release.routingPointId,
    version: release.version,
    digest: release.digest,
    draftVersion: release.draftVersion,
    createdAt: release.createdAt,
    createdBy: release.createdBy,
    counts: {
      nodes: release.snapshot.nodes.length,
      pools: Object.keys(release.snapshot.pools).length,
      members: Object.values(release.snapshot.pools).reduce(
        (count, pool) => count + pool.members.length,
        0,
      ),
      agents: release.snapshot.releaseIds.length,
      humanQueues: Object.keys(release.snapshot.queues).length,
    },
    numbers: numbers.get(release.id) ?? 0,
  }));
}
