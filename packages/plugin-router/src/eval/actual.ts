import type { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import type { SimulationRun } from '../simulate/index.ts';
import { FALLBACK_STEPS, type EngineName, type FallbackStepName } from './types.ts';

/** One engine verdict of a run, as the scorer reads it. */
export interface NodeVerdict {
  node: string;
  engine: EngineName;
  outcome: string;
  branch?: string;
  confidence?: number;
}

/** What a simulated call actually did, in the terms a corpus case expects things in. */
export interface CaseActual {
  status: SimulationRun['outcome']['status'];
  path: string[];
  node: string | null;
  /** node -> the branch its last `matched` verdict chose. */
  branches: Record<string, string>;
  verdicts: NodeVerdict[];
  pool?: { id: string; name: string };
  member?: string;
  agentId?: string;
  queue?: string;
  language: string | null;
  /** The deepest fallback step the route reached; `none` for a clean route. */
  fallback: 'none' | FallbackStepName;
  /** A re-ask was taken at least once. */
  clarify: boolean;
  /** Nodes where a fallback step ran, any kind. */
  fallbackNodes: string[];
}

/**
 * The deepest step that decided the route: a step that was taken, or the release default even when
 * it failed (the chain was exhausted). Skipped and failed steps before it do not count; re-asks
 * and a branch target that failed (`target`) are not fallback steps.
 */
function deepest(steps: readonly { step: string; result: string }[]): CaseActual['fallback'] {
  let best = -1;
  for (const { step, result } of steps) {
    const depth = FALLBACK_STEPS.indexOf(step as FallbackStepName);
    if (depth > best && (result === 'taken' || step === 'release_default')) best = depth;
  }
  return best < 0 ? 'none' : FALLBACK_STEPS[best]!;
}

export function actualOf(run: SimulationRun, snapshot: RoutingReleaseSnapshot): CaseActual {
  const { outcome } = run;
  const steps = run.turns.flatMap((turn) => turn.steps);
  const verdicts: NodeVerdict[] = [];
  const fallbacks: { step: string; result: string; node: string }[] = [];
  for (const step of steps) {
    const p = step.payload as Record<string, any>;
    if (step.type === 'route.node')
      verdicts.push({
        node: p.node,
        engine: p.engine,
        outcome: p.outcome,
        ...(p.branch !== undefined ? { branch: p.branch } : {}),
        ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
      });
    if (step.type === 'route.fallback')
      fallbacks.push({ step: p.step, result: p.result, node: p.node });
  }
  const branches: Record<string, string> = {};
  for (const verdict of verdicts)
    if (verdict.outcome === 'matched' && verdict.branch) branches[verdict.node] = verdict.branch;
  const poolId =
    outcome.agent?.poolId ?? (outcome.status === 'queue' ? run.pools.at(-1)?.poolId : undefined);
  const pool = poolId ? snapshot.pools[poolId] : undefined;
  return {
    status: outcome.status,
    path: outcome.path,
    node: outcome.node,
    branches,
    verdicts,
    ...(pool ? { pool: { id: pool.id, name: pool.name } } : {}),
    ...(outcome.agent?.memberId ? { member: outcome.agent.memberId } : {}),
    ...(outcome.agent ? { agentId: outcome.agent.agentId } : {}),
    // `human` also records a refused precheck on a call that went elsewhere; `queue` is where it went.
    ...(outcome.status === 'human' && outcome.human ? { queue: outcome.human.queueKey } : {}),
    language: outcome.language,
    fallback: deepest(fallbacks),
    clarify: fallbacks.some((entry) => entry.step === 'reask' && entry.result === 'taken'),
    fallbackNodes: [...new Set(fallbacks.map((entry) => entry.node))],
  };
}

/** What a case that never ran did: nothing. */
export const blankActual = (): CaseActual => ({
  status: 'undecided',
  path: [],
  node: null,
  branches: {},
  verdicts: [],
  language: null,
  fallback: 'none',
  clarify: false,
  fallbackNodes: [],
});
