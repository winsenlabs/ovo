import {
  ROUTE_VARIABLE_PREFIX,
  type RouteAgentRef,
  type RouteContext,
  type RoutingHost,
  type RoutingReleaseSnapshot,
  type RoutingTarget,
  type SegmentHandoffPort,
} from '@winsendotai/ovo-contracts';
import { pickLine } from './lines.ts';
import { pickMember } from './members.ts';

/** A target the router can finish on: an agent whose graph is prepared, or a spoken end. */
export type Resolution =
  | {
      kind: 'agent';
      agentId: string;
      releaseId: string;
      handoffId: string;
      poolId?: string;
      memberId?: string;
      claimId?: string;
      /** Why the route went ahead in a weaker form (`claims_unavailable`). */
      degraded?: string;
    }
  | { kind: 'end'; line: string; disposition?: string; degraded?: string }
  | { kind: 'callback'; line: string; inMinutes: number; agentId: string; releaseId: string };

/** How the route finished: the resolution, the path that led to it, and the node it ended at. */
export type RouteOutcome = Resolution & { path: readonly string[]; node: string };

export type Attempt = { ok: true; resolution: Resolution } | { ok: false; reason: string };

export interface TargetEnv {
  snapshot: RoutingReleaseSnapshot;
  host: Pick<RoutingHost, 'claim' | 'now'>;
  handoff: Pick<SegmentHandoffPort, 'prepare'>;
  context: RouteContext;
  path: readonly string[];
  /** A prepared handoff, the moment it exists, so a cancelled turn can abandon it. */
  prepared: (handoffId: string) => void;
  signal: AbortSignal;
}

/** The `ovo_route_*` call variables the target agent receives: the language and each context value. */
export function routeVariables(context: RouteContext): Record<string, string> {
  return {
    ...(context.language ? { [`${ROUTE_VARIABLE_PREFIX}language`]: context.language } : {}),
    ...Object.fromEntries(
      Object.entries(context.values).map(([key, value]) => [
        `${ROUTE_VARIABLE_PREFIX}${key}`,
        value,
      ]),
    ),
  };
}

function pinned(ref: RouteAgentRef): { agentId: string; releaseId: string } | undefined {
  return ref.release.kind === 'pinned'
    ? { agentId: ref.agentId, releaseId: ref.release.releaseId }
    : undefined;
}

async function prepare(
  env: TargetEnv,
  agent: { agentId: string; releaseId: string },
  member?: { poolId: string; memberId: string; claimId?: string; degraded?: string },
): Promise<Attempt> {
  if (!env.snapshot.releaseIds.includes(agent.releaseId))
    return { ok: false, reason: 'release_not_allowed' };
  const request = {
    kind: 'agent' as const,
    reason: 'route' as const,
    ...agent,
    variables: routeVariables(env.context),
    route: {
      path: env.path.slice(-32),
      ...(member ? { poolId: member.poolId, memberId: member.memberId } : {}),
      ...(member?.claimId ? { claimId: member.claimId } : {}),
    },
  };
  let result: Awaited<ReturnType<SegmentHandoffPort['prepare']>>;
  try {
    result = await env.handoff.prepare(request, env.signal);
  } catch {
    env.signal.throwIfAborted();
    return { ok: false, reason: 'compose_failed' };
  }
  if (!result.ok) return { ok: false, reason: result.reason };
  env.prepared(result.handoffId);
  env.signal.throwIfAborted();
  return {
    ok: true,
    resolution: {
      kind: 'agent',
      ...agent,
      handoffId: result.handoffId,
      ...(member ? { poolId: member.poolId, memberId: member.memberId } : {}),
      ...(member?.claimId ? { claimId: member.claimId } : {}),
      ...(member?.degraded ? { degraded: member.degraded } : {}),
    },
  };
}

/**
 * Resolves one target (§7.5 step 4). A pool picks and claims a member, an agent is direct; both are
 * then prepared through the handoff port, which composes the target graph without starting it. An
 * end or a callback resolves to its line. A human queue is R3: it fails `human_queue_unavailable`,
 * and so does every other failure, by reason, for the caller's fallback chain to move on.
 */
export async function attemptTarget(target: RoutingTarget, env: TargetEnv): Promise<Attempt> {
  const { snapshot, context } = env;
  const line = (lines: Parameters<typeof pickLine>[0]) =>
    pickLine(lines, context.language, snapshot.language.default);
  switch (target.kind) {
    case 'end':
      return {
        ok: true,
        resolution: {
          kind: 'end',
          line: line(target.line),
          ...(target.disposition ? { disposition: target.disposition } : {}),
        },
      };
    case 'callback': {
      const agent = (target.agent && pinned(target.agent)) ?? pinned(snapshot.defaultTarget)!;
      const resolution = { line: line(target.line), inMinutes: target.inMinutes, ...agent };
      return { ok: true, resolution: { kind: 'callback', ...resolution } };
    }
    case 'human':
      return { ok: false, reason: 'human_queue_unavailable' };
    case 'agent': {
      const agent = pinned(target.agent);
      return agent ? prepare(env, agent) : { ok: false, reason: 'release_unpinned' };
    }
    case 'pool': {
      const pick = await pickMember({
        pools: snapshot.pools,
        target,
        context,
        defaultLanguage: snapshot.language.default,
        host: env.host,
        signal: env.signal,
      });
      if (pick.kind === 'failed') return { ok: false, reason: pick.reason };
      const { candidate } = pick;
      return prepare(
        env,
        { agentId: candidate.agentId, releaseId: candidate.releaseId },
        {
          poolId: candidate.poolId,
          memberId: candidate.memberId,
          ...(pick.kind === 'claimed' ? { claimId: pick.claimId } : { degraded: pick.reason }),
        },
      );
    }
  }
}
