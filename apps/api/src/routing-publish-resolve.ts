import {
  routingAgentRefs,
  routingAudioIds,
  routingPoolIds,
  type RouteAgentRef,
  type RoutingAudio,
  type RoutingPath,
  type RoutingPointDraft,
  type RoutingPool,
} from '@winsendotai/ovo-contracts';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

export type RoutingReleaseStore = Pick<ControlStore, 'getRelease' | 'listReleases'>;

/**
 * Where an agent reference sits: the router, the default target, a tree target, a pool member or
 * a transfer catalogue destination (Wave 16).
 */
export type ResolvedRole = 'router' | 'default' | 'target' | 'member' | 'transfer';

export interface ResolvedRef {
  role: ResolvedRole;
  /** A draft path, or `['pools', poolId, 'members', index, 'agent']` for a member. */
  path: RoutingPath;
  ref: RouteAgentRef;
  /** Absent when the agent has no release, or the pinned release is not that agent's. */
  release?: ReleaseRecord;
}

/** A pool as publish finds it: live, soft-deleted, or unknown (undefined). */
export type PoolLookup = (id: string) => Promise<RoutingPool | 'deleted' | undefined>;
/** A hold clip as publish finds it, deleted ones included (`deletedAt` set), or unknown. */
export type AudioLookup = (id: string) => Promise<RoutingAudio | undefined>;

export interface RoutingResolution {
  refs: ResolvedRef[];
  /** Every pool a tree target or a transfer destination names, by id. */
  pools: Map<string, RoutingPool | 'deleted' | undefined>;
  /** Every clip a hold step names, by id. */
  audio: Map<string, RoutingAudio | undefined>;
}

/** The live pool, when the lookup found one. */
export const livePool = (found: RoutingPool | 'deleted' | undefined) =>
  found === 'deleted' ? undefined : found;

/**
 * The newest published release of an agent. Release lists are oldest first in every store, so
 * this pages to the end (the same walk the readiness route does).
 */
async function latestRelease(
  store: RoutingReleaseStore,
  workspaceId: string,
  agentId: string,
): Promise<ReleaseRecord | undefined> {
  let latest: ReleaseRecord | undefined;
  let cursor: string | undefined;
  do {
    const page = await store.listReleases(workspaceId, agentId, 100, cursor);
    latest = page.items.at(-1) ?? latest;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return latest;
}

/**
 * Resolves `latest` or `pinned` to a release of this workspace that belongs to the named agent.
 * The store is workspace-scoped, so another workspace's release id resolves to nothing.
 */
export function releaseResolver(store: RoutingReleaseStore, workspaceId: string) {
  const cache = new Map<string, Promise<ReleaseRecord | undefined>>();
  return (ref: RouteAgentRef): Promise<ReleaseRecord | undefined> => {
    const key =
      ref.release.kind === 'pinned'
        ? `${ref.agentId}\u0000${ref.release.releaseId}`
        : `${ref.agentId}\u0000latest`;
    let found = cache.get(key);
    if (!found) {
      found =
        ref.release.kind === 'pinned'
          ? store
              .getRelease(workspaceId, ref.release.releaseId)
              .then((release) => (release?.agentId === ref.agentId ? release : undefined))
          : latestRelease(store, workspaceId, ref.agentId);
      cache.set(key, found);
    }
    return found;
  };
}

/**
 * Resolves every agent reference of a draft and of the pools it names (design 8.4), and every clip
 * its hold sequences play (Wave 16).
 */
export async function resolveRouting(input: {
  draft: RoutingPointDraft;
  workspaceId: string;
  store: RoutingReleaseStore;
  pool: PoolLookup;
  audio: AudioLookup;
}): Promise<RoutingResolution> {
  const resolve = releaseResolver(input.store, input.workspaceId);
  const refs: ResolvedRef[] = [];
  const add = async (role: ResolvedRole, path: RoutingPath, ref: RouteAgentRef) => {
    const release = await resolve(ref);
    refs.push({ role, path, ref, ...(release ? { release } : {}) });
  };
  const role = (index: number, path: RoutingPath): ResolvedRole =>
    index === 0
      ? 'router'
      : index === 1
        ? 'default'
        : path[0] === 'transfer'
          ? 'transfer'
          : 'target';
  for (const [index, { path, ref }] of routingAgentRefs(input.draft).entries())
    await add(role(index, path), path, ref);
  const pools = new Map<string, RoutingPool | 'deleted' | undefined>();
  for (const id of routingPoolIds(input.draft)) pools.set(id, await input.pool(id));
  for (const [poolId, pool] of pools)
    for (const [index, member] of (livePool(pool)?.definition.members ?? []).entries())
      await add('member', ['pools', poolId, 'members', index, 'agent'], member.agent);
  const audio = new Map<string, RoutingAudio | undefined>();
  for (const id of routingAudioIds(input.draft)) audio.set(id, await input.audio(id));
  return { refs, pools, audio };
}

/** The router's resolved reference (always the first). */
export const routerRef = (resolution: RoutingResolution) => resolution.refs[0]!;
