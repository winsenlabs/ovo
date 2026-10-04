import {
  compileDecisionRequest,
  resolveDecision,
  validateDecisionExchange,
  type AgentDecisionPolicy,
  type DecisionPort,
  type DecisionRequest,
  type DecisionResolution,
} from '@winsendotai/ovo-contracts';

/** Everything a decision may be grounded in. The policy chooses which of these the model sees. */
export interface DecisionTurn {
  input: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  variables: Readonly<Record<string, unknown>>;
  context: string;
}

export interface DecisionAction {
  /** Spoken instead of calling the LLM. The first trusted outcome that speaks wins. */
  say?: string;
  /** No trusted outcome spoke, and at least one question deferred to the LLM. */
  deferToLlm: boolean;
  /** No trusted outcome spoke, and every deferring question asked for the clarification line. */
  clarify: boolean;
}

export type DecisionGateResult =
  | { kind: 'off' }
  /**
   * The model did not produce a usable answer. The turn proceeds exactly as an unconfigured agent
   * would: a decision model being slow, down or wrong must never drop a live call.
   */
  | { kind: 'unavailable'; reason: 'timeout' | 'error' | 'invalid'; message: string }
  | {
      kind: 'decided';
      modelId: string;
      resolutions: readonly DecisionResolution[];
      action: DecisionAction;
    };

/**
 * Runs the authored decision policy against the selected decision plugin, applies each authored
 * confidence threshold, and reports what the turn should do. It performs no effect itself: the
 * behaviour speaks, records and routes, so the gate stays pure enough to test without a session.
 *
 * It re-validates the exchange even though a conformant plugin already has. The plugin boundary is
 * the product; a third-party decision plugin is expected, and the invariant that an answer matches
 * the question asked is not one the host delegates.
 */
export class DecisionGate {
  constructor(
    private readonly policy: AgentDecisionPolicy,
    private readonly port: DecisionPort | undefined,
    private readonly clock: { timeout(ms: number): AbortSignal } = {
      timeout: (ms) => AbortSignal.timeout(ms),
    },
  ) {}

  async evaluate(turn: DecisionTurn, signal: AbortSignal): Promise<DecisionGateResult> {
    if (!this.policy.enabled) return { kind: 'off' };
    if (!this.port)
      return {
        kind: 'unavailable',
        reason: 'error',
        message: 'No decision plugin is available for a configured decision policy',
      };
    const request = compileDecisionRequest(this.policy, this.state(turn));
    const deadline = this.clock.timeout(this.policy.timeoutMs);
    let response;
    try {
      response = await this.port.decide(request, {
        signal: AbortSignal.any([signal, deadline]),
      });
    } catch (error) {
      // A cancelled turn is not a decision failure; the caller is already gone.
      signal.throwIfAborted();
      if (deadline.aborted)
        return {
          kind: 'unavailable',
          reason: 'timeout',
          message: `Decision did not answer within ${this.policy.timeoutMs}ms`,
        };
      return {
        kind: 'unavailable',
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    signal.throwIfAborted();
    let resolutions: DecisionResolution[];
    let modelId: string;
    try {
      const exchange = validateDecisionExchange(request, response);
      modelId = exchange.response.modelId;
      resolutions = this.policy.questions.map((question) =>
        resolveDecision(question, exchange.response.answers[question.id]!),
      );
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: 'invalid',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return { kind: 'decided', modelId, resolutions, action: action(resolutions) };
  }

  /** Only the authored sources, always the same keys, so the model's state shape never drifts. */
  private state(turn: DecisionTurn): DecisionRequest['state'] {
    const state: Record<string, unknown> = {};
    for (const source of this.policy.state.sources) {
      if (source === 'last-turn') state['lastCallerTurn'] = turn.input;
      else if (source === 'transcript')
        state['transcript'] = turn.history
          .slice(-this.policy.state.transcriptTurns)
          .map((entry) => ({
            speaker: entry.role === 'user' ? 'caller' : 'agent',
            said: entry.content,
          }));
      else if (source === 'variables') state['variables'] = turn.variables;
      else state['briefing'] = turn.context;
    }
    return state;
  }
}

/**
 * Fold the per-question resolutions into one instruction for the turn. Questions are asked together
 * and answered together, so the authored order decides which scripted line is spoken.
 */
export function action(resolutions: readonly DecisionResolution[]): DecisionAction {
  let say: string | undefined;
  let deferToLlm = false;
  let clarify = false;
  for (const resolution of resolutions) {
    if (resolution.used) {
      say ??= resolution.outcome.say;
      continue;
    }
    if (resolution.fallback === 'llm') deferToLlm = true;
    else clarify = true;
  }
  // Once something has been said the turn is answered, so a deferral no longer has anything to add.
  if (say !== undefined) return { say, deferToLlm: false, clarify: false };
  // A single question wanting the LLM outranks clarification: the LLM can still answer the caller.
  return { deferToLlm, clarify: clarify && !deferToLlm };
}
