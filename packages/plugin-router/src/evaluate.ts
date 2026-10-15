import {
  ROUTING_LIMITS,
  type RouteNodePayload,
  type RoutingBranch,
  type RoutingNode,
  type RoutingReleaseSnapshot,
  type RoutingTarget,
} from '@winsendotai/ovo-contracts';
import {
  isInstantEngine,
  type EngineResult,
  type EngineRunners,
  type RouteTurn,
} from './engines/index.ts';
import type { RouteRecorder } from './events.ts';
import type { RouterState } from './state.ts';

export interface EvaluateEnv {
  snapshot: RoutingReleaseSnapshot;
  nodes: ReadonlyMap<string, RoutingNode>;
  runners: EngineRunners;
  recorder: RouteRecorder;
  now: () => number;
  signal: AbortSignal;
}

/**
 * Where one turn left the route:
 * - `target`: a branch with a target was chosen at `node`;
 * - `ask`: the turn chose its way into `node`, which needs the caller (it was not decided on the
 *   same turn), so its question is due;
 * - `undecided`: the node the caller was answering had its turn and nothing decided; `clarify` is
 *   a generated re-ask question, when an engine produced one.
 */
export type Evaluation =
  | { kind: 'target'; node: RoutingNode; branch: RoutingBranch; target: RoutingTarget }
  | { kind: 'ask'; node: RoutingNode }
  | { kind: 'undecided'; node: RoutingNode; clarify?: string };

interface Verdict {
  branch?: RoutingBranch;
  slots?: Record<string, string>;
  clarify?: string;
}

function contextValue(state: RouterState, key: string): string | undefined {
  return key === 'language' ? state.context.language : state.context.values[key];
}

function setContext(state: RouterState, allowed: readonly string[], key: string, value: string) {
  if (key !== 'language') state.context.values[key] = value;
  else if (allowed.includes(value)) state.context.language = value;
}

function nodeEvent(
  turn: number,
  node: string,
  kind: RouteNodePayload['engine'],
  result: EngineResult,
  ms?: number,
): RouteNodePayload {
  return {
    turn,
    node,
    engine: kind,
    outcome: result.outcome,
    ...(result.branch !== undefined ? { branch: result.branch } : {}),
    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    ...(ms !== undefined ? { ms } : {}),
    ...(result.modelId ? { modelId: result.modelId.slice(0, 200) } : {}),
    ...(result.reason ? { reason: result.reason.slice(0, 200) } : {}),
  };
}

/**
 * One node's verdict on one turn (§7.5 step 2). A value the route context already holds for the
 * node's `sets` key that names one of its branches decides first (`engine: context`); otherwise
 * the engines run in order and the first `matched` wins. Without a turn (the opening, or a node
 * that does not reuse the turn that chose it) only engines that need none run. A detected language
 * is kept whatever the verdict, so a re-ask is said in it.
 */
async function decide(
  node: RoutingNode,
  turn: RouteTurn | undefined,
  state: RouterState,
  env: EvaluateEnv,
): Promise<Verdict> {
  const allowed = env.snapshot.language.allowed;
  const branches = new Map(node.branches.map((branch) => [branch.key, branch]));
  const prefilled = node.sets === undefined ? undefined : contextValue(state, node.sets);
  if (prefilled !== undefined && branches.has(prefilled)) {
    const result: EngineResult = { outcome: 'matched', branch: prefilled, confidence: 1 };
    env.recorder.node(nodeEvent(state.turns, node.id, 'context', result));
    return { branch: branches.get(prefilled)! };
  }
  let clarify: string | undefined;
  for (const engine of node.engines) {
    if (!turn && !isInstantEngine(engine)) continue;
    const started = env.now();
    const input = {
      node,
      ...(turn ? { turn } : {}),
      context: { ...state.context, values: { ...state.context.values } },
      languages: allowed,
      transcript: state.transcript,
      signal: env.signal,
    };
    let result: EngineResult;
    try {
      result = await env.runners[engine.kind](engine as never, input);
    } catch {
      env.signal.throwIfAborted();
      result = { outcome: 'error', reason: `${engine.kind}_failed` };
    }
    const known = result.branch !== undefined && branches.has(result.branch);
    if (result.outcome === 'matched' && !known)
      result = { ...result, outcome: 'error', reason: 'unknown_branch' };
    env.recorder.node(
      nodeEvent(state.turns, node.id, engine.kind, result, Math.max(0, env.now() - started)),
    );
    if (result.language !== undefined) setContext(state, allowed, 'language', result.language);
    clarify ??= result.clarify;
    if (result.outcome === 'matched')
      return {
        branch: branches.get(result.branch!)!,
        ...(result.slots ? { slots: result.slots } : {}),
      };
  }
  return clarify ? { clarify } : {};
}

/**
 * Evaluates the current node on `turn` and follows chosen `next` branches (§7.5 steps 2-3). A node
 * entered on this turn is evaluated on the same turn when it has `reuseTurn` (one utterance can
 * answer several nodes), otherwise only by context and instant engines; at most `depth` nodes per
 * turn. The chosen branch key is stored under the node's `sets` key, an engine's slots under
 * theirs, and every node entered is appended to the path.
 */
export async function evaluateTurn(
  state: RouterState,
  turn: RouteTurn | undefined,
  env: EvaluateEnv,
): Promise<Evaluation> {
  let node = env.nodes.get(state.node)!;
  const allowed = env.snapshot.language.allowed;
  for (let depth = 1; ; depth += 1) {
    const verdict = await decide(
      node,
      depth === 1 || node.reuseTurn ? turn : undefined,
      state,
      env,
    );
    if (!verdict.branch)
      return depth === 1
        ? { kind: 'undecided', node, ...(verdict.clarify ? { clarify: verdict.clarify } : {}) }
        : { kind: 'ask', node };
    const { branch } = verdict;
    if (node.sets !== undefined) setContext(state, allowed, node.sets, branch.key);
    for (const [key, value] of Object.entries(verdict.slots ?? {}))
      setContext(state, allowed, key, value);
    if (branch.target) return { kind: 'target', node, branch, target: branch.target };
    const next = env.nodes.get(branch.next!);
    // A `next` naming no node is refused at publish (`routing_node_unknown`); never at run time.
    if (!next) return { kind: 'undecided', node };
    state.node = next.id;
    state.path.push(next.id);
    node = next;
    if (depth >= ROUTING_LIMITS.depth) return { kind: 'ask', node };
  }
}
