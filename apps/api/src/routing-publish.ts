import {
  routingDraftIssues,
  routingNodeTargets,
  RoutingReleaseSnapshot,
  type PinnedAgentRef,
  type PoolSnapshot,
  type QueueSnapshot,
  type RouteAgentRef,
  type RoutingIssue,
  type RoutingPoint,
  type RoutingPointDraft,
  type RoutingRelease,
} from '@winsendotai/ovo-contracts';
import { routingSnapshotDigest, type RoutingService } from '@winsendotai/ovo-plugin-operations';
import { routingResolutionIssues, type RoutingCheckInput } from './routing-publish-checks.ts';
import { pinnedTransfer } from './routing-publish-transfer.ts';
import {
  livePool,
  resolveRouting,
  type AudioLookup,
  type PoolLookup,
  type QueueLookup,
  type RoutingReleaseStore,
  type RoutingResolution,
} from './routing-publish-resolve.ts';

export interface RoutingPublishContext extends Omit<
  RoutingCheckInput,
  'draft' | 'resolution' | 'store'
> {
  store: RoutingReleaseStore & RoutingCheckInput['store'];
  routing: Pick<RoutingService, 'releases'>;
  pool: PoolLookup;
  audio: AudioLookup;
  queue?: QueueLookup;
}

/**
 * Full publish validation (design 8.4): the structural issues of the draft and every resolution
 * check against the releases, pools and credentials it names. Writes nothing.
 */
export async function validateRoutingDraft(
  context: RoutingPublishContext,
  draft: RoutingPointDraft,
): Promise<{ issues: RoutingIssue[]; resolution: RoutingResolution }> {
  const resolution = await resolveRouting({
    draft,
    workspaceId: context.workspaceId,
    store: context.store,
    pool: context.pool,
    audio: context.audio,
    queue: context.queue,
  });
  const issues = [
    ...routingDraftIssues(draft),
    ...(await routingResolutionIssues({ ...context, draft, resolution })),
  ];
  return { issues, resolution };
}

/**
 * The immutable snapshot a routing release freezes: the draft with every agent reference pinned to
 * the release it resolved to (transfer destinations included), every named pool with its members
 * pinned, every hold clip pinned by sha256, the de-duplicated release ids, and the sha256 digest
 * over its canonical JSON the release is stored under. A draft with a transfer catalogue freezes
 * as schema version 2, and one that binds human queues as version 3 with each queue's definition
 * pinned by value (staffing stays live). Only called once validation found no errors.
 */
export function buildRoutingSnapshot(
  pointId: string,
  draft: RoutingPointDraft,
  resolution: RoutingResolution,
): { snapshot: RoutingReleaseSnapshot; digest: string } {
  const pinned = new Map<RouteAgentRef, PinnedAgentRef>();
  for (const { ref, release } of resolution.refs)
    if (release)
      pinned.set(ref, {
        agentId: ref.agentId,
        release: { kind: 'pinned', releaseId: release.id },
      });
  const pin = (ref: RouteAgentRef) => {
    const found = pinned.get(ref);
    if (!found) throw new Error(`Agent ${ref.agentId} has no resolved release`);
    return found;
  };
  const nodes = structuredClone(draft.nodes);
  // `routingNodeTargets` walks the clone in the same order as the draft it was resolved from.
  const originals = routingNodeTargets(draft.nodes);
  routingNodeTargets(nodes).forEach(({ target }, index) => {
    const original = originals[index]!.target;
    if (target.kind === 'agent' && original.kind === 'agent') target.agent = pin(original.agent);
    if (target.kind === 'callback' && original.kind === 'callback' && original.agent)
      target.agent = pin(original.agent);
  });
  const pools: Record<string, PoolSnapshot> = {};
  for (const [id, found] of resolution.pools) {
    const pool = livePool(found);
    if (pool)
      pools[id] = {
        id,
        version: pool.version,
        name: pool.definition.name,
        languageFallback: pool.definition.languageFallback,
        members: pool.definition.members.map((member) => ({
          ...member,
          agent: pin(member.agent),
        })),
      };
  }
  const queues: Record<string, QueueSnapshot> = {};
  for (const binding of draft.humanQueues ?? []) {
    const found = resolution.queues.get(binding.queueId);
    if (found && found !== 'deleted')
      queues[binding.queueId] = {
        id: binding.queueId,
        version: found.version,
        key: binding.key,
        priority: binding.priority,
        definition: found.definition,
      };
  }
  const releaseIds = [...new Set([...pinned.values()].map((ref) => ref.release.releaseId))];
  const transfer = draft.transfer && pinnedTransfer(draft.transfer, resolution, pin);
  const snapshot = RoutingReleaseSnapshot.parse({
    ...draft,
    schemaVersion: draft.humanQueues?.length ? 3 : transfer ? 2 : 1,
    queues,
    ...(transfer ? { transfer } : {}),
    routingPointId: pointId,
    router: pin(draft.router),
    defaultTarget: pin(draft.defaultTarget),
    nodes,
    pools,
    releaseIds,
  });
  return { snapshot, digest: routingSnapshotDigest(snapshot) };
}

export type RoutingPublishResult =
  | { kind: 'blocked'; blockers: RoutingIssue[]; warnings: RoutingIssue[] }
  | { kind: 'conflict' }
  | { kind: 'created'; release: RoutingRelease; warnings: RoutingIssue[] };

/** Publishes the point's stored draft as its next routing release, or says why it cannot. */
export async function publishRoutingPoint(
  context: RoutingPublishContext,
  point: RoutingPoint,
  createdBy: string,
): Promise<RoutingPublishResult> {
  const { issues, resolution } = await validateRoutingDraft(context, point.draft);
  const blockers = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  if (blockers.length) return { kind: 'blocked', blockers, warnings };
  const { snapshot, digest } = buildRoutingSnapshot(point.id, point.draft, resolution);
  const release = await context.routing.releases.create({
    pointId: point.id,
    draftVersion: point.draftVersion,
    snapshot,
    digest,
    createdBy,
  });
  return release ? { kind: 'created', release, warnings } : { kind: 'conflict' };
}
