import {
  FLOW_RESUME_END,
  compileFlow,
  findFlowIntent,
  flowDecisionRequest,
  matchFlowPhrase,
  readFlowAnswer,
  routeFlowIntent,
  type AgentFlow,
  type CompiledFlow,
  type FlowIntent,
  type FlowPosition,
  type FlowTransition,
} from '@winsendotai/ovo-contracts';
import type { DecisionTurn } from './decision-gate.ts';
import { callDecision, flowDecisionState } from './flow-decide.ts';
import {
  UNVERIFIED_FACTS_NOTICE,
  type FlowLine,
  type FlowRules,
  type FlowSessionOptions,
  type FlowStep,
} from './flow-types.ts';

export * from './flow-types.ts';

const PATH_LIMIT = 100;

/**
 * One call's position in an authored flow (AGT-1). It lives as long as the session's behaviour, so
 * every turn is judged against the listen set of the state the call is actually in, and the path
 * it took is kept (bounded) for the call record.
 *
 * Each caller turn is resolved in tiers: a whole-reply phrase match (no network), then one
 * decision request scoped to the current listen set plus the global intents and `other`, then the
 * flow's fallback. `next` only proposes a step; `commit` applies it, so a turn superseded before it
 * speaks never moves the call.
 */
export class FlowSession {
  readonly compiled: CompiledFlow;
  private position: FlowPosition = {};
  private started = false;
  private ended = false;
  private confirmed = false;
  private last: FlowLine[] = [];
  private readonly transitions: FlowTransition[] = [];
  private readonly listeners = new Set<(transition: FlowTransition) => void>();

  constructor(
    flow: AgentFlow,
    private readonly options: FlowSessionOptions,
  ) {
    this.compiled = compileFlow(flow);
  }

  get state(): Readonly<FlowPosition & { started: boolean; ended: boolean; verified: boolean }> {
    return { ...this.position, started: this.started, ended: this.ended, verified: this.verified };
  }

  /** The transitions this call made, oldest first, at most the last 100. */
  get path(): readonly FlowTransition[] {
    return this.transitions;
  }

  /** False only while the flow gates identity and no identity-confirming node has been entered. */
  get verified(): boolean {
    return !this.compiled.gatesIdentity || this.confirmed;
  }

  onTransition(listener: (transition: FlowTransition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Entering the start node, which the first turn does whatever the caller said. Once only. */
  begin(): FlowStep | undefined {
    if (this.started) return undefined;
    return this.enter(this.compiled.flow.start, { tier: 'start' });
  }

  async next(turn: DecisionTurn, signal: AbortSignal): Promise<FlowStep> {
    const first = this.begin();
    if (first) return first;
    const listen = this.position.listen;
    if (this.ended || listen === undefined) return this.fallback({ reason: 'ended' });
    const ruled = (this.options.rules ?? defaultRules)(turn.input, listen, this.compiled);
    const matched = ruled === undefined ? undefined : findFlowIntent(this.compiled, listen, ruled);
    if (matched)
      return this.follow(matched, {}, { tier: 'rule', intent: matched.key, confidence: 1 });

    const request = flowDecisionRequest(
      this.compiled,
      listen,
      flowDecisionState(turn, this.options.transcriptTurns ?? 6, this.options.sources ?? []),
    );
    const call = await callDecision(this.options.port, request, {
      timeoutMs: this.options.timeoutMs,
      signal,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      trace: { flow: { ...(this.position.node ? { node: this.position.node } : {}), listen } },
    });
    if (!call.ok)
      return this.fallback(
        { reason: 'unavailable' },
        { reason: call.reason, message: call.message },
      );
    let answer;
    try {
      answer = readFlowAnswer(this.compiled, request, call.response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fallback({ reason: 'unavailable' }, { reason: 'invalid', message });
    }
    const judged = {
      intent: answer.intent,
      confidence: answer.confidence,
      modelId: answer.modelId,
    };
    if (answer.kind !== 'intent') return this.fallback({ reason: answer.kind, ...judged });
    const intent = findFlowIntent(this.compiled, listen, answer.intent)!;
    return this.follow(intent, answer.slots, { tier: 'decision', ...judged, slots: answer.slots });
  }

  /** Apply a step this turn is about to speak. `skippedLines` are lines that could not render. */
  commit(step: FlowStep, skippedLines: readonly string[] = []): void {
    if (step.kind === 'enter') {
      const node = this.compiled.nodes.get(step.node)!;
      this.started = true;
      this.position = { node: node.id, ...(node.listen ? { listen: node.listen } : {}) };
      this.last = step.lines;
      this.ended = node.end;
      if (node.verified) this.confirmed = true;
    }
    this.record(
      skippedLines.length
        ? { ...step.transition, skippedLines: [...skippedLines] }
        : step.transition,
    );
  }

  /**
   * The resume points the LLM fallback may pick now: the listen sets it may hand the call back to
   * (only those before identity confirmation while it is pending), and `end` when allowed.
   */
  resumeOptions(endAllowed: boolean): string[] {
    const listens = [...this.compiled.listens.keys()].filter(
      (id) => this.verified || this.compiled.preVerificationListens.has(id),
    );
    return endAllowed ? [...listens, FLOW_RESUME_END] : listens;
  }

  /**
   * The LLM answered a reply the flow could not place (AGT-7) and chose where the flow resumes.
   * A resume point the flow does not offer leaves the call where it was. Returns true when the
   * call should end after the LLM's reply.
   */
  rejoin(resumeAt: string | undefined, endAllowed: boolean): boolean {
    const from = { ...this.position };
    const valid = resumeAt !== undefined && this.resumeOptions(endAllowed).includes(resumeAt);
    if (valid && resumeAt === FLOW_RESUME_END) {
      this.ended = true;
      this.position = from.node ? { node: from.node } : {};
    } else if (valid) {
      this.started = true;
      this.ended = false;
      this.position = { ...(from.node ? { node: from.node } : {}), listen: resumeAt };
    }
    this.record({
      at: this.now(),
      from,
      to: { ...this.position },
      tier: 'llm',
      ...(resumeAt === undefined ? {} : { intent: resumeAt }),
      ...(resumeAt !== undefined && !valid ? { reason: 'invalid-resume' as const } : {}),
    });
    return valid && resumeAt === FLOW_RESUME_END;
  }

  /** The LLM's call facts, or the notice that replaces them until identity is confirmed. */
  gateFacts(facts: string): string {
    return this.verified || !facts ? facts : UNVERIFIED_FACTS_NOTICE;
  }

  private follow(
    intent: FlowIntent,
    slots: Readonly<Record<string, string>>,
    trace: Partial<FlowTransition> & Pick<FlowTransition, 'tier'>,
  ): FlowStep {
    const target = routeFlowIntent(intent, slots);
    if (target.kind === 'node') return this.enter(target.node, trace);
    const prefix = this.compiled.flow.repeatPrefix;
    return {
      kind: 'repeat',
      lines: [...(prefix ? [this.line(prefix)] : []), ...this.last],
      transition: this.transition({ ...this.position }, trace),
    };
  }

  private enter(
    nodeId: string,
    trace: Partial<FlowTransition> & Pick<FlowTransition, 'tier'>,
  ): FlowStep {
    const node = this.compiled.nodes.get(nodeId)!;
    return {
      kind: 'enter',
      node: node.id,
      lines: node.say.map((id) => this.line(id)),
      end: node.end,
      transition: this.transition(
        { node: node.id, ...(node.listen ? { listen: node.listen } : {}) },
        { ...trace, ...(node.disposition ? { disposition: node.disposition } : {}) },
      ),
    };
  }

  /**
   * A reply that fits nothing. After the call's ending node was barged into, a flow without an
   * LLM says its goodbye again rather than leaving the caller in a state with nothing to listen for.
   */
  private fallback(
    trace: Partial<FlowTransition>,
    unavailable?: { reason: 'timeout' | 'error' | 'invalid'; message: string },
  ): FlowStep {
    const flow = this.compiled.flow;
    if (trace.reason === 'ended' && flow.fallback === 'clarify' && this.position.node)
      return this.enter(this.position.node, { tier: 'fallback', reason: 'ended' });
    return {
      kind: 'fallback',
      action: flow.fallback,
      ...(flow.fallback === 'clarify' && flow.clarify ? { line: this.line(flow.clarify) } : {}),
      transition: this.transition({ ...this.position }, { ...trace, tier: 'fallback' }),
      ...(unavailable ? { unavailable } : {}),
    };
  }

  private transition(
    to: FlowPosition,
    trace: Partial<FlowTransition> & Pick<FlowTransition, 'tier'>,
  ): FlowTransition {
    return { at: this.now(), from: { ...this.position }, to, ...trace };
  }

  private line(id: string): FlowLine {
    return { id, template: this.compiled.flow.lines[id]! };
  }

  private record(transition: FlowTransition): void {
    this.transitions.push(transition);
    if (this.transitions.length > PATH_LIMIT) this.transitions.shift();
    for (const listener of this.listeners) listener(transition);
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

const defaultRules: FlowRules = (reply, listen, flow) => matchFlowPhrase(flow, listen, reply);
