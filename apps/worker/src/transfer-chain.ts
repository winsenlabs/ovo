import type { HoldTimeoutStep } from '@winsendotai/ovo-contracts';
import type { SegmentReason } from './transfer-attempt.ts';
import { agentTarget, memberCandidate, memberTarget, routerTarget } from './transfer-begin.ts';
import { TRANSFER_CLAIM_RETRY_MS, type ConnectHost, type TransferRun } from './transfer-types.ts';

/** What waiting for a candidate came to: `ready`, the call or the hold ending, or a failure code. */
export type Waited = 'ready' | 'ended' | 'call_limit' | 'hold_timeout' | string;

/** A `target`, `default` or `return` step's candidate, or why it could not be begun. */
export async function chainStep(
  host: ConnectHost,
  run: TransferRun,
  step: Extract<HoldTimeoutStep, { kind: 'target' | 'default' | 'return' }>,
): Promise<{ attempt: TransferRun['attempt'] } | string> {
  const { deps } = host;
  if (step.kind === 'default') return { attempt: host.attempt(run, fallbackTarget(host, run)) };
  if (step.kind === 'return') {
    const member = memberCandidate(run.from);
    // Best effort: the member the caller left is claimed again; storage down or full, it is not.
    const claim = member ? await deps.claims.claim([[member]]) : undefined;
    const target = {
      ...{ agentId: run.from.agentId, releaseId: run.from.releaseId },
      ...{ variables: run.request.variables, role: 'agent' as const, reason: 'return' as const },
      ...(member ? { poolId: member.poolId, memberId: member.memberId } : {}),
      ...(claim?.kind === 'claimed' ? { claimId: claim.claimId } : {}),
      captured: { ...deps.memory.captured },
    };
    return { attempt: host.attempt(run, target) };
  }
  if (step.key === (run.target?.key ?? run.meta?.key)) return 'own_key';
  const resolved = await deps.resolveTarget?.(step.key, run.from);
  if (!resolved) return 'unknown_target';
  if ('refusal' in resolved) return resolved.refusal;
  const { request } = resolved;
  run.target = resolved.target;
  run.claimed = resolved.claimed || run.claimed;
  // The router's own handoff that falls back to another target is still a route fallback.
  const reason: SegmentReason = run.transfer !== undefined ? 'transfer' : 'fallback';
  if (request.kind === 'agent')
    return { attempt: host.attempt(run, agentTarget(host, request, reason)) };
  if (request.kind === 'node')
    return { attempt: host.attempt(run, routerTarget(host, run, request.node)) };
  const claim = await deps.claims.claim(request.tiers);
  if (claim.kind !== 'full')
    return { attempt: host.attempt(run, memberTarget(host, run, claim, reason)) };
  if (!run.hold.policy.waitForCapacity) return 'pool_full';
  run.queue = { poolId: request.poolId, tiers: request.tiers, since: host.clock.now() };
  return { attempt: undefined };
}

/** The routing release's default target: direct, with no member claim. */
export function fallbackTarget(host: ConnectHost, run: TransferRun) {
  const { fallback, memory } = host.deps;
  return {
    ...{ agentId: fallback.agentId, releaseId: fallback.releaseId },
    ...{ variables: run.request.variables, role: 'agent' as const },
    reason: (run.transfer !== undefined ? 'transfer' : 'fallback') as SegmentReason,
    captured: { ...memory.captured },
  };
}

/**
 * Waits for the current candidate within `deadline`: a queued one claims again every three
 * seconds (and composes once a member has room), a composing one settles. `ready`, or why not.
 */
export async function waitForTarget(
  host: ConnectHost,
  run: TransferRun,
  deadline: number,
): Promise<Waited> {
  const { deps, clock } = host;
  let tries = 0;
  for (;;) {
    if (host.ended) return 'ended';
    const left = deadline - clock.now();
    if (left <= 0) return deadline >= deps.callEndsAt ? 'call_limit' : 'hold_timeout';
    if (run.queue && !run.attempt) {
      // `begin` tried once; from then on, every three seconds while the caller holds.
      if (tries > 0 || clock.now() - run.queue.since >= TRANSFER_CLAIM_RETRY_MS) {
        const claim = await deps.claims.claim(run.queue.tiers);
        if (claim.kind !== 'full') {
          run.claimed = claim.kind === 'claimed' || run.claimed;
          const reason: SegmentReason = run.transfer !== undefined ? 'transfer' : 'route';
          run.attempt = host.attempt(run, memberTarget(host, run, claim, reason));
          if (!run.attempt) return 'segments_exhausted';
          continue;
        }
        deps.audit('transfer.claim.retry', { attempt: tries, poolId: run.queue.poolId });
      }
      tries += 1;
      await clock.sleep(Math.min(TRANSFER_CLAIM_RETRY_MS, left), host.endedSignal);
      continue;
    }
    const attempt = run.attempt;
    if (!attempt) return 'segments_exhausted';
    if (attempt.settled !== undefined) return attempt.ready ? 'ready' : (attempt.settled as string);
    const stop = new AbortController();
    await Promise.race([
      attempt.result,
      clock.sleep(left, AbortSignal.any([stop.signal, host.endedSignal])),
    ]);
    stop.abort();
  }
}
