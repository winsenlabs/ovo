import type { RoutingEngine, RoutingEngineKind } from '@winsendotai/ovo-contracts';
import type { EngineInput, EngineResult, EngineRunner, EngineRunners } from '../engines/index.ts';
import type { SimClock } from './host.ts';
import type { SimulatedAnswer, SimulationWarning } from '../wire/index.ts';

type Scripted = Exclude<RoutingEngineKind, 'rules'>;
type LiveRunners = { [K in Scripted]?: EngineRunner<K> };

export interface AnswerRunners {
  runners: EngineRunners;
  /** `engine_unscripted` warnings, one per node and engine, in the order they were first needed. */
  readonly warnings: SimulationWarning[];
  /** Live engine calls made, and the real milliseconds they took. */
  readonly live: { calls: number; ms: number };
}

const asked = (answer: SimulatedAnswer, engine: RoutingEngine) => {
  const threshold = 'threshold' in engine ? engine.threshold : 1;
  const confidence = answer.confidence ?? 1;
  if (answer.outcome) return answer.outcome;
  if (answer.branch) return confidence >= threshold ? 'matched' : 'low_confidence';
  // A classifier that cannot tell reports low confidence; a decision or webhook that names nothing, no match.
  return engine.kind === 'llm' ? 'low_confidence' : 'no_match';
};

/**
 * What the real engine would have reported for a scripted answer: `matched` at or above the
 * engine's own threshold, else `low_confidence`, unless the answer names the outcome. Fields an
 * engine cannot produce are dropped (a language from an LLM that does not detect one, a clarify
 * question without `generatedClarify`, a slot outside the webhook's allow-list), as in the real
 * runners.
 */
export function resultOf(answer: SimulatedAnswer, engine: RoutingEngine): EngineResult {
  const outcome = asked(answer, engine);
  const carries = outcome === 'matched' || outcome === 'low_confidence';
  const result: EngineResult = { outcome };
  if (carries && answer.branch) result.branch = answer.branch;
  if (carries) {
    const confidence = answer.confidence ?? (outcome === 'matched' ? 1 : undefined);
    if (confidence !== undefined) result.confidence = confidence;
  }
  if (engine.kind === 'llm' && carries && engine.detectLanguage && answer.language)
    result.language = answer.language;
  if (
    engine.kind === 'llm' &&
    outcome === 'low_confidence' &&
    engine.generatedClarify &&
    answer.clarify
  )
    result.clarify = answer.clarify;
  if (engine.kind === 'external' && outcome === 'matched' && answer.slots) {
    const slots = Object.entries(answer.slots).filter(([key]) => engine.slots.includes(key));
    if (slots.length) result.slots = Object.fromEntries(slots);
  }
  if (answer.reason) result.reason = answer.reason;
  return result;
}

/**
 * The engine runners of a simulation: `rules` run for real; `decision`, `llm` and `external` answer
 * from the script, per node and engine, in order (`repeat` keeps an answer for every later call),
 * or, where `live` supplies a runner, run for real, advancing the simulated clock by the time they
 * took. An engine asked with nothing scripted reports `no_match` (`unscripted`) and warns once.
 */
export function createAnswerRunners(input: {
  answers: readonly SimulatedAnswer[];
  rules: EngineRunners['rules'];
  live?: LiveRunners;
  clock: SimClock;
}): AnswerRunners {
  const queues = new Map<string, SimulatedAnswer[]>();
  for (const answer of input.answers) {
    const key = `${answer.node}:${answer.engine}`;
    queues.set(key, [...(queues.get(key) ?? []), answer]);
  }
  const warnings: SimulationWarning[] = [];
  const live = { calls: 0, ms: 0 };
  const warned = new Set<string>();
  const runner =
    <K extends Scripted>(kind: K): EngineRunner<K> =>
    async (engine, engineInput: EngineInput) => {
      const real = input.live?.[kind] as EngineRunner<K> | undefined;
      if (real) {
        const started = performance.now();
        try {
          return await real(engine, engineInput);
        } finally {
          const ms = Math.round(performance.now() - started);
          live.calls += 1;
          live.ms += ms;
          input.clock.advance(ms);
        }
      }
      const key = `${engineInput.node.id}:${kind}`;
      const queue = queues.get(key);
      const answer = queue?.[0];
      if (!answer) {
        if (!warned.has(key)) {
          warned.add(key);
          warnings.push({
            code: 'engine_unscripted',
            node: engineInput.node.id,
            engine: kind,
            message: `Node ${engineInput.node.id} asked its ${kind} engine, which has no scripted answer: it reported no match.`,
          });
        }
        return { outcome: 'no_match', reason: 'unscripted' };
      }
      if (!answer.repeat) queue.shift();
      return resultOf(answer, engine);
    };
  return {
    warnings,
    live,
    runners: {
      rules: input.rules,
      decision: runner('decision'),
      llm: runner('llm'),
      external: runner('external'),
    },
  };
}
