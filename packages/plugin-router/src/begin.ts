import {
  effectiveHold,
  TRANSFER_BUILT_IN_LINES,
  type RouteContext,
  type RoutingReleaseSnapshot,
  type RoutingTarget,
  type SegmentHandoffPort,
  type SegmentHandoffRequest,
} from '@winsendotai/ovo-contracts';
import { pickLine } from './lines.ts';
import { eligibleTiers } from './members.ts';
import type { RouterPorts } from './ports.ts';

/**
 * How the router hands the call on (R2 §7.3). R1 asks the host to `prepare` the target and waits
 * for its graph; with transfers on, the host offers `begin`, which claims and starts composing in
 * the background and answers at once, so the connecting line is said with no silent wait and the
 * host's hold covers the rest. A router composed for a re-route (`entry`) hands on as a `transfer`.
 */
export interface HandoffMode {
  reason: 'route' | 'transfer';
  /** A full pool is queued on hold rather than refused (the point's hold `waitForCapacity`). */
  queue: boolean;
}

/** R2: how this router hands on; undefined is R1's `prepare` for a route. */
export function handoffMode(
  ports: Pick<RouterPorts, 'handoff' | 'entry'>,
  snapshot: RoutingReleaseSnapshot,
): HandoffMode | undefined {
  const begin = ports.handoff.begin !== undefined;
  if (!begin && !ports.entry) return undefined;
  const queue = begin && effectiveHold(snapshot.transfer).waitForCapacity;
  return { reason: ports.entry ? 'transfer' : 'route', queue };
}

export interface HandoffEnv {
  handoff: Pick<SegmentHandoffPort, 'prepare' | 'begin'>;
  mode?: HandoffMode;
  /** A prepared or begun handoff, the moment it exists, so a cancelled turn can abandon it. */
  prepared: (handoffId: string) => void;
  signal: AbortSignal;
}

export type HandoffAnswer = { ok: true; handoffId: string } | { ok: false; reason: string };

/** The request's reason and, for a re-route's final handoff, its transfer meta. */
export function requestMode(mode: HandoffMode | undefined) {
  return mode?.reason === 'transfer'
    ? { reason: 'transfer' as const, transfer: { source: 'router' as const } }
    : { reason: 'route' as const };
}

/**
 * Asks the host for the handoff: `begin` when it offers one, else R1's `prepare`. Nothing is asked
 * once the turn was cancelled (R1 audit 4b), a port that throws is `compose_failed`, and a turn
 * cancelled while the host answered throws after the handoff is reported, so it is abandoned.
 */
export async function requestHandoff(
  env: HandoffEnv,
  request: SegmentHandoffRequest,
): Promise<HandoffAnswer> {
  env.signal.throwIfAborted();
  let result: { ok: true; handoffId: string } | { ok: false; reason: string };
  try {
    result = env.handoff.begin
      ? await env.handoff.begin(request, env.signal)
      : await env.handoff.prepare(request, env.signal);
  } catch {
    env.signal.throwIfAborted();
    return { ok: false, reason: 'compose_failed' };
  }
  if (!result.ok) return { ok: false, reason: result.reason };
  env.prepared(result.handoffId);
  env.signal.throwIfAborted();
  return { ok: true, handoffId: result.handoffId };
}

/**
 * Every eligible member of a pool target is at capacity: with `queue` on, the pool is begun as a
 * `queue` handoff (the host retries the claim on hold); otherwise undefined, and the target fails
 * `pool_full` as in R1.
 */
export async function queueHandoff(
  env: HandoffEnv & {
    snapshot: RoutingReleaseSnapshot;
    context: RouteContext;
    variables: Record<string, string>;
    path: readonly string[];
    now: number;
  },
  target: Extract<RoutingTarget, { kind: 'pool' }>,
): Promise<HandoffAnswer | undefined> {
  const pool = env.snapshot.pools[target.poolId];
  if (!env.mode?.queue || !env.handoff.begin || !pool) return undefined;
  const tiers = eligibleTiers({
    pool,
    target,
    context: env.context,
    defaultLanguage: env.snapshot.language.default,
    now: env.now,
  });
  if (!tiers.length) return undefined;
  return requestHandoff(env, {
    kind: 'queue',
    ...requestMode(env.mode),
    poolId: pool.id,
    tiers: tiers.slice(0, 101).map((tier) => tier.slice(0, 100)),
    variables: env.variables,
    route: { path: env.path.slice(-32), poolId: pool.id },
  });
}

/** The line said as a queued call goes on hold: the point's, else the built-in one. */
export function queueLine(snapshot: RoutingReleaseSnapshot, language: string | undefined): string {
  const lines = snapshot.transfer?.queueAnnouncement ?? TRANSFER_BUILT_IN_LINES.queue;
  return pickLine(lines, language, snapshot.language.default);
}
