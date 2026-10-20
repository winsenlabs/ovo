import {
  disclosureParts,
  RoutingPointDraft,
  type RoutingIssue,
  type RoutingPoint,
  type RoutingReleaseSnapshot,
  type SimulationTarget,
  type SimulationWarning,
} from '@winsendotai/ovo-contracts';
import type { RoutingService } from '@winsendotai/ovo-plugin-operations';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { buildRoutingSnapshot, validateRoutingDraft } from './routing-publish.ts';
import type { RoutingPublishContext } from './routing-publish.ts';
import type { RouterInfo } from './routing-simulator.ts';

/** What a simulation (or an eval run) runs against, and where it came from. */
export interface SimulationSource {
  snapshot: RoutingReleaseSnapshot;
  source: {
    kind: 'release' | 'draft';
    pointId: string;
    routingReleaseId: string | null;
    version: number | null;
    digest: string;
  };
  /** Warnings the resolution itself raises (an unpublished draft). */
  warnings: SimulationWarning[];
}

export type SimulationTargetResult =
  | { ok: true; found: SimulationSource }
  | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> };

const refuse = (
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): SimulationTargetResult => ({
  ok: false,
  status,
  code,
  message,
  ...(extra ? { extra } : {}),
});

/** A release by id, or 404. */
export async function releaseSource(
  routing: Pick<RoutingService, 'releases'>,
  routingReleaseId: string,
): Promise<SimulationTargetResult> {
  const release = await routing.releases.get(routingReleaseId);
  if (!release) return refuse(404, 'routing_release_not_found', 'Routing release not found');
  return {
    ok: true,
    found: {
      snapshot: release.snapshot,
      source: {
        kind: 'release',
        pointId: release.routingPointId,
        routingReleaseId: release.id,
        version: release.version,
        digest: release.digest,
      },
      warnings: [],
    },
  };
}

/**
 * Resolves a draft target like publish does: the stored draft (or the given one) is validated
 * against the releases, pools, credentials and queues it names, and a draft with blockers is
 * refused (422 `routing_simulate_blocked`). Nothing is written.
 */
async function draftSource(
  routing: Pick<RoutingService, 'points'>,
  context: RoutingPublishContext,
  target: Extract<SimulationTarget, { kind: 'draft' }>,
): Promise<SimulationTargetResult> {
  const point: RoutingPoint | undefined = await routing.points.get(target.pointId);
  if (!point) return refuse(404, 'routing_point_not_found', 'Routing point not found');
  // The stored draft is parsed again so defaults added since it was saved apply, as at publish.
  const draft = target.draft ?? RoutingPointDraft.parse(point.draft);
  const { issues, resolution } = await validateRoutingDraft(context, draft);
  const blockers: RoutingIssue[] = issues.filter((issue) => issue.severity === 'error');
  if (blockers.length)
    return refuse(422, 'routing_simulate_blocked', 'The draft cannot be simulated', {
      blockers,
      warnings: issues.filter((issue) => issue.severity === 'warning'),
    });
  const { snapshot, digest } = buildRoutingSnapshot(point.id, draft, resolution);
  return {
    ok: true,
    found: {
      snapshot,
      source: {
        kind: 'draft',
        pointId: point.id,
        routingReleaseId: null,
        version: null,
        digest,
      },
      warnings: [
        {
          code: 'draft_unpublished',
          message: 'This draft is not published; no call is routed by it until it is.',
        },
      ],
    },
  };
}

export function simulationSource(
  routing: Pick<RoutingService, 'points' | 'releases'>,
  context: RoutingPublishContext,
  target: SimulationTarget,
): Promise<SimulationTargetResult> {
  return target.kind === 'release'
    ? releaseSource(routing, target.routingReleaseId)
    : draftSource(routing, context, target);
}

/**
 * The router release's timezone and disclosure, which the router reads from its agent config. A
 * release that has gone missing reads as the defaults: the simulation is still worth running.
 */
export async function routerInfo(
  store: Pick<ControlStore, 'getRelease'>,
  workspaceId: string,
  snapshot: RoutingReleaseSnapshot,
): Promise<RouterInfo> {
  const release = await store.getRelease(workspaceId, snapshot.router.release.releaseId);
  if (!release) return {};
  return {
    timezone: release.config.timezone,
    disclosure: disclosureParts(release.config.compliance),
  };
}

/** `poolId:memberId` -> active claims, the shape the simulator reads. */
export function loadMap(active: Record<string, Record<string, number>>): Record<string, number> {
  const load: Record<string, number> = {};
  for (const [poolId, members] of Object.entries(active))
    for (const [memberId, count] of Object.entries(members)) load[`${poolId}:${memberId}`] = count;
  return load;
}
