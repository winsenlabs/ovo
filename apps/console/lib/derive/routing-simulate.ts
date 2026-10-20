import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import type {
  EngineMode,
  QueueFault,
  RoutingEvalCaseJson,
  RoutingSimulationResult,
  SimulatedAnswer,
  SimulatedEngine,
  SimulationRequest,
  SimulationStep,
  SimulationTurn,
} from '../types/routing-simulate';
import { SIMULATION_LIMITS } from '../types/routing-simulate';

/** The simulator form: strings where the inputs are, mapped to the wire request by `buildRequest`. */
export interface SimForm {
  target: { kind: 'release'; routingReleaseId: string } | { kind: 'draft'; pointId: string };
  from: string;
  to: string;
  /** A `datetime-local` value (`2026-10-20T10:30`), read in the point's zone; empty = now. */
  at: string;
  variables: { name: string; value: string }[];
  turns: SimulationTurn[];
  answers: SimulatedAnswer[];
  modes: Record<SimulatedEngine, EngineMode>;
  fullMembers: { poolId: string; memberId: string }[];
  failedReleases: { releaseId: string; reason: 'compose_failed' | 'timeout' }[];
  queues: Record<string, QueueFault>;
  load: 'empty' | 'live';
  /** `server`: leave to the server's flag; `on`/`off`: the what-if. */
  transfers: 'server' | 'on' | 'off';
  humanQueues: 'server' | 'on' | 'off';
}

export function blankSimForm(target: SimForm['target']): SimForm {
  return {
    target,
    from: '',
    to: '',
    at: '',
    variables: [],
    turns: [],
    answers: [],
    modes: { decision: 'mock', llm: 'mock', external: 'mock' },
    fullMembers: [],
    failedReleases: [],
    queues: {},
    load: 'empty',
    transfers: 'server',
    humanQueues: 'server',
  };
}

const flag = (value: SimForm['transfers']) => (value === 'server' ? undefined : value === 'on');

/** A `datetime-local` string in a zone to the ISO instant it names (DST-aware, no library). */
export function zonedToIso(local: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!match) return undefined;
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms: number) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).formatToParts(new Date(ms));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
      return (
        Date.UTC(
          get('year'),
          get('month') - 1,
          get('day'),
          get('hour'),
          get('minute'),
          get('second'),
        ) - ms
      );
    } catch {
      return 0;
    }
  };
  // Two passes settle the offset across a DST edge.
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first)).toISOString();
}

export function buildRequest(
  form: SimForm,
  options: { timeZone?: string; draft?: RoutingPointDraft } = {},
): SimulationRequest {
  const variables = Object.fromEntries(
    form.variables.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value]),
  );
  const at = form.at ? zonedToIso(form.at, options.timeZone ?? 'UTC') : undefined;
  return {
    target:
      form.target.kind === 'draft' && options.draft
        ? { ...form.target, draft: options.draft }
        : form.target,
    call: {
      ...(form.from.trim() ? { from: form.from.trim() } : {}),
      ...(form.to.trim() ? { to: form.to.trim() } : {}),
      variables,
      ...(at ? { at } : {}),
    },
    turns: form.turns,
    engines: { mode: form.modes, answers: form.answers },
    faults: {
      fullMembers: form.fullMembers,
      failedReleases: form.failedReleases,
      queues: form.queues,
    },
    load: form.load,
    assume: {
      ...(flag(form.transfers) === undefined ? {} : { transferEnabled: flag(form.transfers) }),
      ...(flag(form.humanQueues) === undefined
        ? {}
        : { humanQueueEnabled: flag(form.humanQueues) }),
    },
  };
}

/** Why a form cannot run yet, or nothing. */
export function formProblem(form: SimForm): string | undefined {
  if (form.target.kind === 'release' && !form.target.routingReleaseId)
    return 'Choose a release to run, or test the draft.';
  if (form.turns.length > SIMULATION_LIMITS.turns)
    return `At most ${SIMULATION_LIMITS.turns} turns.`;
  if (form.from && !/^\+[1-9][0-9]{0,14}$/.test(form.from.trim()))
    return 'The caller number must be international, like +918040000001.';
  if (form.to && !/^\+[1-9][0-9]{0,14}$/.test(form.to.trim()))
    return 'The dialled number must be international, like +918040000001.';
  const empty = form.turns.findIndex(
    (t) =>
      (t.kind === 'speech' && !t.text.trim()) ||
      (t.kind === 'dtmf' && !/^[0-9*#]{1,8}$/.test(t.digits)),
  );
  return empty >= 0 ? `Turn ${empty + 1} is empty or not valid.` : undefined;
}

export interface EngineSlot {
  key: string;
  node: string;
  engine: SimulatedEngine;
  branches: string[];
  detectLanguage: boolean;
  threshold: number;
}

/** One row per `decision`/`llm`/`external` engine in the tree: what the operator can script. */
export function engineSlots(draft: RoutingPointDraft): EngineSlot[] {
  return draft.nodes.flatMap((node) =>
    node.engines.flatMap((engine) =>
      engine.kind === 'rules'
        ? []
        : [
            {
              key: `${node.id}:${engine.kind}`,
              node: node.id,
              engine: engine.kind,
              branches: node.branches.map((b) => b.key),
              detectLanguage: engine.kind === 'llm' && engine.detectLanguage,
              threshold: engine.threshold,
            },
          ],
    ),
  );
}

/** The scripted answer for a slot (the first of its node and engine), if any. */
export const answerOf = (
  answers: readonly SimulatedAnswer[],
  slot: Pick<EngineSlot, 'node' | 'engine'>,
) => answers.find((a) => a.node === slot.node && a.engine === slot.engine);

export function setAnswer(
  answers: readonly SimulatedAnswer[],
  slot: Pick<EngineSlot, 'node' | 'engine'>,
  answer: SimulatedAnswer | undefined,
): SimulatedAnswer[] {
  const rest = answers.filter((a) => !(a.node === slot.node && a.engine === slot.engine));
  return answer ? [...rest, answer] : rest;
}

/** Engines the run asked about with no scripted answer (the trace offers "Answer as..."). */
export function unscripted(
  result: RoutingSimulationResult,
): { node: string; engine: SimulatedEngine }[] {
  return result.warnings
    .filter((w) => w.code === 'engine_unscripted' && w.node && w.engine)
    .map((w) => ({ node: w.node!, engine: w.engine as SimulatedEngine }));
}

export type RouteEvent = Extract<SimulationStep, { type: 'route.node' }>;
export function nodeSteps(result: RoutingSimulationResult) {
  return result.turns.flatMap((turn) =>
    turn.steps
      .filter((s): s is RouteEvent => s.type === 'route.node')
      .map((s) => ({ turn: turn.index, step: s })),
  );
}
export function fallbackSteps(result: RoutingSimulationResult) {
  return result.turns.flatMap((turn) =>
    turn.steps
      .filter((s) => s.type === 'route.fallback')
      .map((s) => ({ turn: turn.index, payload: s.payload })),
  );
}

const FALLBACK_RANK = ['default', 'human', 'callback', 'end', 'limit', 'release_default'] as const;
type Fallback = (typeof FALLBACK_RANK)[number];

/** The deepest non-reask fallback step that was taken, or `none` for a clean route. */
export function deepestFallback(result: RoutingSimulationResult): Fallback | 'none' {
  let deepest = -1;
  for (const { payload } of fallbackSteps(result)) {
    const rank = FALLBACK_RANK.indexOf(payload.step as Fallback);
    if (rank >= 0 && payload.result === 'taken') deepest = Math.max(deepest, rank);
  }
  return deepest < 0 ? 'none' : FALLBACK_RANK[deepest]!;
}

export function clarified(result: RoutingSimulationResult): boolean {
  return fallbackSteps(result).some(
    (f) => f.payload.step === 'reask' && f.payload.result === 'taken',
  );
}

/** An eval case that asserts what this run did: the starting point of a corpus case. */
export function buildEvalCase(
  form: SimForm,
  result: RoutingSimulationResult,
  id: string,
  options: { timeZone?: string } = {},
): RoutingEvalCaseJson {
  const request = buildRequest(form, options);
  const { outcome } = result;
  const picked = result.pools.find((p) => p.result === 'picked');
  const status =
    outcome.status === 'undecided' || outcome.status === 'queue' ? undefined : outcome.status;
  return {
    id,
    tags: [],
    call: request.call,
    turns: request.turns,
    answers: request.engines.answers,
    faults: request.faults,
    expect: {
      ...(status ? { status } : {}),
      ...(outcome.path.length ? { path: outcome.path } : {}),
      ...(outcome.node ? { node: outcome.node } : {}),
      ...(picked ? { pool: picked.poolName } : {}),
      ...(outcome.agent?.memberId ? { member: outcome.agent.memberId } : {}),
      ...(outcome.agent?.agentId ? { agentId: outcome.agent.agentId } : {}),
      ...(outcome.language ? { language: outcome.language } : {}),
      fallback: deepestFallback(result),
      clarify: clarified(result),
    },
  };
}

/** A corpus line: one case as compact JSON. */
export const evalCaseJsonl = (cases: readonly RoutingEvalCaseJson[]) =>
  cases.map((c) => JSON.stringify(c)).join('\n') + '\n';

export const OUTCOME_LABEL: Record<RoutingSimulationResult['outcome']['status'], string> = {
  agent: 'An agent',
  queue: 'Queued for an agent',
  human: 'A person',
  end: 'Call ended',
  callback: 'Callback',
  undecided: 'Undecided',
};
