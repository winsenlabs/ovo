import {
  compileDecisionRequest,
  resolveDecision,
  validateDecisionExchange,
  type AgentDecisionPolicy,
  type DecisionPort,
  type DecisionRequest,
  type DecisionResolution,
} from '@winsendotai/ovo-contracts';
import { callDecision, SYSTEM_DECISION_CLOCK, type DecisionClock } from './flow-decide.ts';
import { FlowSession, type FlowSessionOptions, type FlowStep } from './flow-session.ts';
import { spokenHistory } from './history.ts';

export * from './flow-decide.ts';
export * from './flow-session.ts';

/** Everything a decision may be grounded in. The policy chooses which of these the model sees. */
export interface DecisionTurn {
  input: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  variables: Readonly<Record<string, unknown>>;
  context: string;
  /** Passages retrieved for this turn, already thresholded and trimmed. */
  retrieved?: string;
  /** Today in the agent's locale and timezone. */
  today?: string;
}

export interface DecisionAction {
  /** Spoken instead of calling the LLM. The first trusted outcome that speaks wins. */
  say?: string;
  /** No trusted outcome spoke, and at least one question deferred to the LLM. */
  deferToLlm: boolean;
  /** No trusted outcome spoke, and every deferring question asked for the clarification line. */
  clarify: boolean;
  /**
   * A trusted outcome ends the call after this turn's reply, named `<question>=<answer>`. Never set
   * alongside `clarify`: a turn the decision did not understand does not end the call.
   */
  end?: string;
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
    }
  /** A flow routed this turn; the step is applied only once the turn is still current. */
  | { kind: 'flow'; step: FlowStep };

/**
 * Runs the authored decision policy against the selected decision plugin, applies each authored
 * confidence threshold, and reports what the turn should do. It performs no effect itself: the
 * behaviour speaks, records and routes, so the gate stays pure enough to test without a session.
 *
 * It re-validates the exchange even though a conformant plugin already has. The plugin boundary is
 * the product; a third-party decision plugin is expected, and the invariant that an answer matches
 * the question asked is not one the host delegates.
 *
 * With a flow, the gate holds the session's `FlowSession` and asks only the listen set of the
 * state the call is in. The gate lives as long as the behaviour, which is one per session.
 */
export class DecisionGate {
  /** This session's position in the authored flow, when the policy routes by one. */
  readonly flow?: FlowSession;

  constructor(
    private readonly policy: AgentDecisionPolicy,
    private readonly port: DecisionPort | undefined,
    private readonly clock: DecisionClock = SYSTEM_DECISION_CLOCK,
    flowOptions: Pick<FlowSessionOptions, 'rules' | 'now'> = {},
  ) {
    if (policy.flow)
      this.flow = new FlowSession(policy.flow, {
        ...flowOptions,
        ...(port ? { port } : {}),
        timeoutMs: policy.timeoutMs,
        transcriptTurns: policy.state.transcriptTurns,
        sources: policy.state.sources,
        clock,
      });
  }

  async evaluate(turn: DecisionTurn, signal: AbortSignal): Promise<DecisionGateResult> {
    if (!this.policy.enabled) return { kind: 'off' };
    if (this.flow) return { kind: 'flow', step: await this.flow.next(turn, signal) };
    // No questions is a script's policy: it only widens transition matching (`script.ts`).
    if (!this.policy.questions.length) return { kind: 'off' };
    const request = compileDecisionRequest(this.policy, this.state(turn));
    const call = await callDecision(this.port, request, {
      timeoutMs: this.policy.timeoutMs,
      signal,
      clock: this.clock,
    });
    if (!call.ok) return { kind: 'unavailable', reason: call.reason, message: call.message };
    let resolutions: DecisionResolution[];
    let modelId: string;
    try {
      const exchange = validateDecisionExchange(request, call.response);
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
    // The decision model judges what was said, so the playback notes kept for the LLM are dropped.
    const spoken = spokenHistory(turn.history);
    for (const source of this.policy.state.sources) {
      if (source === 'last-turn') state['lastCallerTurn'] = turn.input;
      else if (source === 'agent-last-said')
        state['agentLastSaid'] =
          [...spoken].reverse().find((entry) => entry.role === 'assistant')?.content ?? '';
      else if (source === 'today') state['today'] = turn.today ?? '';
      else if (source === 'transcript')
        state['transcript'] = spoken.slice(-this.policy.state.transcriptTurns).map((entry) => ({
          speaker: entry.role === 'user' ? 'caller' : 'agent',
          said: entry.content,
        }));
      else if (source === 'variables') state['variables'] = turn.variables;
      else if (source === 'knowledge') state['retrieved'] = turn.retrieved ?? '';
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
  let end: string | undefined;
  let deferToLlm = false;
  let clarify = false;
  for (const resolution of resolutions) {
    if (resolution.used) {
      say ??= resolution.outcome.say;
      if (resolution.outcome.end) end ??= `${resolution.questionId}=${answerLabel(resolution)}`;
      continue;
    }
    if (resolution.fallback === 'llm') deferToLlm = true;
    else clarify = true;
  }
  const ending = end === undefined ? {} : { end };
  // Once something has been said the turn is answered, so a deferral no longer has anything to add.
  if (say !== undefined) return { say, deferToLlm: false, clarify: false, ...ending };
  // A single question wanting the LLM outranks clarification: the LLM can still answer the caller.
  if (clarify && !deferToLlm) return { deferToLlm, clarify: true };
  return { deferToLlm, clarify: false, ...ending };
}

function answerLabel(resolution: Extract<DecisionResolution, { used: true }>): string {
  const { answer } = resolution;
  if (answer.type === 'choice') return answer.choice;
  if (answer.type === 'noul') return answer.noul >= 0.5 ? 'yes' : 'no';
  return `score:${answer.score}`;
}
