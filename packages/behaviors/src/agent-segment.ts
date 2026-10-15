import {
  disclosureParts,
  type AgentConfig,
  type Execution,
  type Inference,
} from '@winsendotai/ovo-contracts';
import { flowBriefing } from './flow-step.ts';
import { replyGuardrail } from './agent-pre-reply.ts';
import { AgentSessionAhead } from './agent-session-ahead.ts';
import { assembleBoundedContext } from './context.ts';
import type { AgentBehaviorOptions } from './agent-tools.ts';
import { AgentTransfers, type TransferAnswer } from './agent-transfer.ts';
import type { AgentSpeculationOptions } from './speculation.ts';
import { TransferGreeting } from './transfer-greeting.ts';
import { handoverHeard } from './transfer-handover.ts';

/**
 * R2: an agent call as one segment of a routed call. It may hand the caller to another agent
 * (`transfer_to_agent`, flow end nodes), greets a caller handed to it as configured, and records
 * its disclosure once heard so later segments skip it. Without the host's `ovo.agent-transfer`
 * port (every direct call) none of this does anything. `AgentBehavior` adds the turn itself.
 */
export abstract class AgentSegment extends AgentSessionAhead {
  protected readonly transfers: AgentTransfers;
  private readonly greeting: TransferGreeting;
  /** On a segment that took over a call: its context without the handover, the caller's words. */
  private readonly own?: { context: string; heard: string[] };

  constructor(
    config: AgentConfig,
    inference: Inference | undefined,
    execution: Execution,
    options: AgentBehaviorOptions & AgentSpeculationOptions,
  ) {
    super(config, inference, execution, options);
    this.transfers = new AgentTransfers(this.config, options.transfer, {
      arm: (reason) => this.ending.arm(reason, { final: true }),
      ...(options.events ? { events: options.events } : {}),
    });
    this.transfers.offer(this.tools, this.validators);
    const { inbound } = options.transfer ?? {};
    this.greeting = new TransferGreeting(this.config, inbound, this.inference, !!this.flow);
    if (inbound) {
      const context = assembleBoundedContext(this.config.context, this.config.contextBudget);
      this.own = { context, heard: handoverHeard(inbound) };
    }
  }

  /**
   * The reply guardrail's sources on a segment that took over a call: its own briefing, never the
   * handover's summary (another model wrote it), and the caller's words before the handover. Empty
   * on any other call, whose guardrail reads the briefing as before.
   */
  protected guardrailSources(variables: Record<string, unknown>) {
    if (!this.own) return {};
    const declared = flowBriefing(this.flow, this.own.context, (text) =>
      this.variables.renderBriefing(text, variables),
    );
    return { declared, heard: this.own.heard };
  }

  /** The `llm` greeting's checks, as a reply's: the language guard (N4), then the guardrail. */
  private greetingCheck(variables: Record<string, unknown>): (line: string) => string | undefined {
    const { declared = this.briefing(variables), heard = [] } = this.guardrailSources(variables);
    const facts = this.variables.facts(variables);
    const { guardrail } = this.guard.input([]);
    const reply = replyGuardrail(this.config, guardrail, [declared, facts], variables, 0, heard);
    const inner = reply && ((segment: string) => reply.check(segment));
    const language = this.languages.reply(inner);
    return (line) => (language ? language.check(line) : inner ? inner(line) : line);
  }

  /** An `llm` greeting of a transferred call speaks first even with no opening lines. */
  override speaksFirst = (): boolean => this.greeting.speaksFirst() || this.lines.speaksFirst();

  protected override heardDisclosure(): void {
    const kinds = disclosureParts(this.config.compliance).map((part) => part.kind);
    this.transfers.heardDisclosure(kinds);
  }

  /** The opening turn: an `llm` greeting of a transferred call, else the scripted opening. */
  protected opening(variables: Record<string, unknown>): AsyncIterable<string> {
    return this.greeting.opening({
      briefing: () => this.briefing(variables),
      check: (line) => this.greetingCheck(variables)(line),
      disclosure: () => this.sayDisclosure(),
      say: (text) => this.say(text, this.turn),
      scripted: () => this.lines.opening(variables, this.flow),
      signal: () => (this.active = new AbortController()).signal,
    });
  }

  /**
   * R2: a turn after a transfer to another agent was committed only ends the segment into it;
   * nothing is said, so a barge-in on the announcement cannot undo it. Undefined without one.
   */
  protected handedOff(input: string): Iterable<string> | undefined {
    const handoff = this.transfers.committed;
    return handoff === undefined ? undefined : this.closeFlow(input, handoff);
  }

  /**
   * A flow end node that transfers (`end` is the turn's `flow:<node>`): the announcement for a
   * node with no lines, '' for one with lines, undefined when the node does not transfer.
   */
  protected async flowHandoff(
    end: string | undefined,
    said: boolean,
    turn: { signal: AbortSignal; current: () => boolean },
  ): Promise<string | undefined> {
    const announcement = await this.transfers.flowEnd(end, turn);
    return announcement === undefined ? undefined : said ? '' : announcement;
  }

  /** A transfer's announcement as the turn's whole reply. */
  protected *announce(text: string, turn: number): Generator<string> {
    yield this.say(text, turn);
    this.ending.seal();
  }

  /** The model's `transfer_to_agent` on the turn answering `input`. */
  protected transferTool(
    input: string,
    previous: readonly string[],
    turn: { signal: AbortSignal; current: () => boolean },
  ): (call: unknown) => Promise<TransferAnswer> {
    return (call) => this.transfers.llm(call, { input, previous, ...turn });
  }
}
