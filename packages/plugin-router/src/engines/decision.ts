import {
  validateDecisionExchange,
  type DecisionPort,
  type DecisionRequest,
  type RoutingEngine,
} from '@winsendotai/ovo-contracts';
import {
  EngineTimeout,
  turnText,
  withDeadline,
  type EngineInput,
  type EngineResult,
  type EngineRunner,
} from './types.ts';

type DecisionEngine = Extract<RoutingEngine, { kind: 'decision' }>;

/** The one choice question the decision engine asks, and the state key names it is judged on. */
export const ROUTE_QUESTION_ID = 'route';
const TRANSCRIPT_LINES = 12;

/**
 * The decision request for one node and turn: a `choice` question whose criteria are the branch
 * descriptions, judged on the caller's last turn and what the router and the caller said so far.
 */
export function routeDecisionRequest(engine: DecisionEngine, input: EngineInput): DecisionRequest {
  return {
    state: {
      'last-caller-turn': turnText(input.turn),
      'router-transcript': input.transcript
        .slice(-TRANSCRIPT_LINES)
        .map((line) => `${line.role}: ${line.text}`),
    },
    questions: {
      [ROUTE_QUESTION_ID]: {
        type: 'choice',
        instructions: engine.instructions,
        criteria: Object.fromEntries(
          input.node.branches.map((branch) => [branch.key, branch.description]),
        ),
      },
    },
  };
}

/**
 * The decision engine (§7.6) over the router release's decision slot (Jev today). The reply is
 * checked against the request with `validateDecisionExchange`: an incoherent one is an `error`.
 * Absent `Cap.decision` reports `disabled`; the engine's own deadline reports `timeout`. A choice
 * needs two branches, so a one-branch node is an `error` too (publish validation refuses it).
 */
export function createDecisionRunner(port: DecisionPort | undefined): EngineRunner<'decision'> {
  return async (engine: DecisionEngine, input: EngineInput): Promise<EngineResult> => {
    if (!port) return { outcome: 'disabled', reason: 'decision_unavailable' };
    if (input.node.branches.length < 2) return { outcome: 'error', reason: 'single_branch' };
    if (!turnText(input.turn)) return { outcome: 'no_match', reason: 'empty_turn' };
    const request = routeDecisionRequest(engine, input);
    let raw: unknown;
    try {
      raw = await withDeadline(engine.timeoutMs, input.signal, (signal) =>
        port.decide(request, { signal }),
      );
    } catch (error) {
      if (error instanceof EngineTimeout) return { outcome: 'timeout' };
      input.signal.throwIfAborted();
      return { outcome: 'error', reason: 'decision_failed' };
    }
    let exchange: ReturnType<typeof validateDecisionExchange>;
    try {
      exchange = validateDecisionExchange(request, raw);
    } catch {
      return { outcome: 'error', reason: 'incoherent' };
    }
    const modelId = exchange.response.modelId;
    const answer = exchange.response.answers[ROUTE_QUESTION_ID];
    if (answer?.type !== 'choice') return { outcome: 'error', reason: 'incoherent', modelId };
    const verdict = { branch: answer.choice, confidence: answer.confidence, modelId };
    return answer.confidence >= engine.threshold
      ? { outcome: 'matched', ...verdict }
      : { outcome: 'low_confidence', ...verdict };
  };
}
