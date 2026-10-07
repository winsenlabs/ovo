import {
  FLOW_RESUME_END,
  compileFlow,
  type AgentFlow,
  type CompiledFlow,
  type FlowPosition,
  type FlowTransition,
} from '@winsendotai/ovo-contracts';
import type { DecisionTurn } from './decision-gate.ts';
import { decideFlowReply } from './flow-decide.ts';
import { FlowPlayout } from './flow-playout.ts';
import { FlowProposals } from './flow-proposals.ts';
import {
  UNVERIFIED_FACTS_NOTICE,
  type FlowLine,
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
 *
 * Entering an `end` node is final: no later turn, decision or LLM resume moves the call out of it.
 */
export class FlowSession {
  readonly compiled: CompiledFlow;
  private position: FlowPosition = {};
  private started = false;
  private ended = false;
  private confirmed = false;
  /** The entered node's lines, which a repeat replays until the agent has said anything. */
  private last: FlowLine[] = [];
  /** What the agent said last and what the caller heard of the node's mandatory lines. */
  private readonly playout = new FlowPlayout();
  private readonly transitions: FlowTransition[] = [];
  private readonly listeners = new Set<(transition: FlowTransition) => void>();
  private readonly propose: FlowProposals;

  constructor(
    flow: AgentFlow,
    private readonly options: FlowSessionOptions,
  ) {
    this.compiled = compileFlow(flow);
    this.propose = new FlowProposals(
      this.compiled,
      () => ({ position: this.position, last: this.last, playout: this.playout }),
      () => this.now(),
    );
  }

  get state(): Readonly<FlowPosition & { started: boolean; ended: boolean; verified: boolean }> {
    return { ...this.position, started: this.started, ended: this.ended, verified: this.verified };
  }

  /** The transitions this call made, oldest first, at most the last 100. */
  get path(): readonly FlowTransition[] {
    return this.transitions;
  }

  /**
   * False only while the flow gates identity and no identity-confirming node has been entered, or
   * one has but its mandatory lines (the disclosure) have not been heard yet.
   */
  get verified(): boolean {
    return !this.compiled.gatesIdentity || this.confirmed;
  }

  /** The current node's mandatory line ids the caller has not heard in full yet. */
  get unheardLines(): readonly string[] {
    return this.playout.unheardLines;
  }

  /** The mandatory lines the caller has heard in full on this call, as said (P10). */
  get disclosed(): readonly string[] {
    return this.playout.disclosed;
  }

  onTransition(listener: (transition: FlowTransition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Entering the start node, which the first turn does whatever the caller said. Once only. */
  begin(): FlowStep | undefined {
    if (this.started) return undefined;
    return this.propose.enter(this.compiled.flow.start, { tier: 'start' });
  }

  async next(turn: DecisionTurn, signal: AbortSignal): Promise<FlowStep> {
    const first = this.begin();
    if (first) return first;
    const listen = this.position.listen;
    if (this.ended || listen === undefined) return this.propose.fallback({ reason: 'ended' });
    const at = { ...(this.position.node ? { node: this.position.node } : {}), listen };
    const reply = await decideFlowReply(this.compiled, this.options, at, turn, signal);
    const step =
      reply.kind === 'intent'
        ? this.propose.follow(reply.intent, reply.slots, reply.trace)
        : this.propose.fallback(reply.trace, reply.unavailable);
    return this.propose.unheardReplay(step) ?? step;
  }

  /** Apply a step this turn is about to speak. `skippedLines` are lines that could not render. */
  commit(step: FlowStep, skippedLines: readonly string[] = []): void {
    let transition = skippedLines.length
      ? { ...step.transition, skippedLines: [...skippedLines] }
      : step.transition;
    if (step.transition.reason === 'unheard') this.playout.replayed();
    else {
      // The caller moved on without hearing them; the record says what they missed.
      const unheard = this.playout.abandon();
      if (unheard.length) {
        transition = { ...transition, unheardLines: unheard };
        this.confirmIfVerified();
      }
    }
    if (step.kind === 'enter') {
      const node = this.compiled.nodes.get(step.node)!;
      this.started = true;
      this.position = { node: node.id, ...(node.listen ? { listen: node.listen } : {}) };
      this.last = step.lines;
      this.ended = node.end;
      this.playout.entered(node, skippedLines);
      if (!this.playout.unheardLines.length) this.confirmIfVerified();
    }
    this.record(transition);
  }

  /**
   * A mandatory line of the current node played to its end (P5), as `text`. Once all have, an
   * identity-confirming node counts as confirmed.
   */
  heard(lineId: string, text?: string): void {
    if (this.playout.heard(lineId, text)) this.confirmIfVerified();
  }

  /**
   * A line the agent said in conversational turn `turn`: a node's line or the LLM's reply. A
   * repeat says the latest turn's lines again (P6), so "can you repeat the number?" hears the
   * number the LLM just gave, not the node the call happens to be in.
   */
  said(turn: number, text: string): void {
    this.playout.said(turn, text);
  }

  /**
   * The resume points the LLM fallback may pick now: before identity is confirmed only the listen
   * sets that come before it, after it only those that come after it, and `end` when allowed. Once
   * the call has ended there is nothing to go back to.
   */
  resumeOptions(endAllowed: boolean): string[] {
    const end = endAllowed ? [FLOW_RESUME_END] : [];
    if (this.ended) return end;
    const { preVerificationListens, postVerificationListens } = this.compiled;
    const listens = [...this.compiled.listens.keys()].filter((id) =>
      this.verified ? postVerificationListens.has(id) : preVerificationListens.has(id),
    );
    return [...listens, ...end];
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

  private confirmIfVerified(): void {
    if (this.compiled.nodes.get(this.position.node!)?.verified) this.confirmed = true;
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
