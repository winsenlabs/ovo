import Ajv, { type ValidateFunction } from 'ajv';
import {
  classifyConfirmation,
  HANDOFF_REASON_PREFIX,
  type AgentConfig,
  type AgentTransferPort,
  type AgentTransferResult,
  type EventSink,
  type ToolDefinition,
  type TransferTargetOffer,
} from '@winsendotai/ovo-contracts';
import {
  confirmQuestion,
  refusalInstruction,
  TRANSFER_DECLINED,
  transferInput,
  transferToAgentTool,
} from './agent-transfer-tool.ts';
import { recordSessionEvent } from './outcome-events.ts';

/**
 * The port, as the worker provides it. `summary` says whether the point's handover takes the
 * transferring agent's summary (`handover.summary`); absent, it does, as the policy defaults.
 */
export type TransferPort = AgentTransferPort & { readonly summary?: boolean };

/** What the model's `transfer_to_agent` comes to: a line the agent says, or a record to read. */
export type TransferAnswer = { kind: 'say'; text: string } | { kind: 'record'; error: string };

/**
 * The model's `transfer_to_agent` on one turn; `withdrawn` answers a call the model made though the
 * tool was not offered (undefined when that does not apply: it is then an unknown tool).
 */
export type TransferTool = ((input: unknown) => Promise<TransferAnswer>) & {
  withdrawn?: (input: unknown) => Promise<string> | undefined;
};

/** The turn a `transfer_to_agent` was called in. */
export interface TransferTurn {
  /** The caller's words this turn. */
  input: string;
  /** What the agent said in its previous turn. */
  previous: readonly string[];
  signal: AbortSignal;
  /** False once a newer turn superseded this one. */
  current: () => boolean;
}

/**
 * R2 inside one agent segment of a routed call: the `transfer_to_agent` tool, the confirm gate,
 * flow end nodes that transfer, and the call's disclosure record. Everything is inert without the
 * host's `ovo.agent-transfer` port (a direct call never has one), so a direct call is unchanged.
 *
 * A transfer is asked of the host, which gates and begins it. Once it is accepted the behaviour
 * commits it, then arms a final `handoff:<key>` ending and says the announcement as the whole
 * reply: from the commit on, a barge-in no longer undoes it (the host is already handing on).
 */
export class AgentTransfers {
  private readonly offers: readonly TransferTargetOffer[];
  private reason?: string;
  private disclosed = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly port: TransferPort | undefined,
    private readonly host: { arm: (reason: string) => void; events?: EventSink },
  ) {
    this.offers = port && config.handoff?.agents?.llmTool ? port.targets() : [];
  }

  /** The handoff reason once a transfer is committed: the segment ends into it, whatever happens. */
  get committed(): string | undefined {
    return this.reason;
  }

  /** Adds `transfer_to_agent` beside the authored tools when the point grants this agent targets. */
  offer(tools: ToolDefinition[], validators: Map<string, ValidateFunction>): void {
    if (!this.offers.length) return;
    const tool = transferToAgentTool(this.offers, this.port?.summary !== false);
    tools.push(tool);
    validators.set(tool.id, new Ajv({ allErrors: true, strict: false }).compile(tool.inputSchema));
  }

  /**
   * The model's `transfer_to_agent` (its input valid). A target whose confirm is `ask` goes ahead
   * only when the agent's previous line asked about it and the caller's words this turn are a
   * plain yes: otherwise the agent asks (the model's own `confirmed` counts for nothing, and when
   * it claimed one the host records the refusal), and a no is the model's to answer.
   */
  async llm(input: unknown, turn: TransferTurn): Promise<TransferAnswer> {
    const { key, claimed, ...meta } = transferInput(input);
    const offer = this.offers.find((candidate) => candidate.key === key);
    let confirmed = false;
    if (offer?.confirm === 'ask') {
      const question = confirmQuestion(offer, this.config.language);
      const heard = turn.previous.includes(question) ? classifyConfirmation(turn.input) : 'unclear';
      if (heard === 'no') return { kind: 'record', error: TRANSFER_DECLINED };
      confirmed = heard === 'yes';
      if (!confirmed && !claimed) return { kind: 'say', text: question };
    }
    const summary = this.port?.summary === false ? {} : meta;
    const request = { key, source: 'llm' as const, ...summary, confirmed };
    const result = await this.port!.request(request, turn.signal);
    if (!result.ok)
      return offer && result.reason === 'not_confirmed'
        ? { kind: 'say', text: confirmQuestion(offer, this.config.language) }
        : { kind: 'record', error: refusalInstruction(result.reason) };
    return { kind: 'say', text: await this.accept(key, result, turn) };
  }

  /**
   * Design 7.3: the model called `transfer_to_agent` on a segment that was not offered it, because
   * the call had used up its transfers (or segments, or time) when the segment started. The host
   * still gates it, so the refusal (`limit_reached`, ...) is recorded as `transfer.requested`, and
   * the model reads it. Undefined when the tool was offered, or this agent never transfers by tool.
   */
  withdrawn(input: unknown, signal: AbortSignal): Promise<string> | undefined {
    if (!this.port || this.offers.length || !this.config.handoff?.agents?.llmTool) return undefined;
    const target = (input as { target?: unknown } | null | undefined)?.target;
    const key = typeof target === 'string' ? target : '';
    return this.refuse(this.port, key, signal);
  }

  private async refuse(port: TransferPort, key: string, signal: AbortSignal): Promise<string> {
    const result = await port.request({ key, source: 'llm', confirmed: false }, signal);
    if (!result.ok) return refusalInstruction(result.reason);
    // Unreachable while the limits only tighten; a transfer begun anyway is not taken.
    // swallow-ok: cancel is idempotent cleanup before commit; the host disposes the graph anyway.
    await port.cancel(result.transferId).catch(() => undefined);
    return refusalInstruction('limit_reached');
  }

  /**
   * A flow end node listed in `handoff.agents.nodes` (`end` is the turn's `flow:<node>`): the
   * flow is its confirmation. The announcement to say when the node has no lines of its own, or
   * undefined when the node does not transfer or the host refused (its ending then stands).
   */
  async flowEnd(end: string | undefined, turn: Omit<TransferTurn, 'input' | 'previous'>) {
    const node = end?.startsWith('flow:') ? end.slice('flow:'.length) : undefined;
    const key = node && this.config.handoff?.agents?.nodes[node];
    if (!key || !this.port) return undefined;
    const result = await this.port.request({ key, source: 'flow', confirmed: true }, turn.signal);
    return result.ok ? this.accept(key, result, turn) : undefined;
  }

  /** P5 on a segmented call: the disclosure was heard in full, so later segments skip its kinds. */
  heardDisclosure(kinds: readonly string[]): void {
    if (!this.port || this.disclosed || !kinds.length) return;
    this.disclosed = true;
    recordSessionEvent(this.host.events, 'disclosure', { kinds: [...kinds] });
  }

  /** Commit first, then arm; a turn superseded before the commit cancels the transfer instead. */
  private async accept(
    key: string,
    result: Extract<AgentTransferResult, { ok: true }>,
    turn: Pick<TransferTurn, 'signal' | 'current'>,
  ): Promise<string> {
    if (turn.signal.aborted || !turn.current()) {
      // swallow-ok: cancel is idempotent cleanup before commit; the host disposes the graph anyway.
      await this.port!.cancel(result.transferId).catch(() => undefined);
      throw new DOMException('transfer superseded before commit', 'AbortError');
    }
    this.port!.commit(result.transferId);
    this.reason = `${HANDOFF_REASON_PREFIX}${key}`;
    this.host.arm(this.reason);
    return result.announcement;
  }
}
