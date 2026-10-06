import type { AgentConfig, EventSink, OperationRecord } from '@winsendotai/ovo-contracts';
import { agentGuardrailInput, GuardrailMetrics, type ReplyGuardrailInput } from './guardrail.ts';

/** An agent's reply guardrail across one call: every turn's tool results, and what it checked. */
export class AgentReplyGuard {
  /** Sentences the reply guardrail checked, flagged, blocked and dropped, and what it cost. */
  readonly metrics = new GuardrailMetrics();
  /** Each turn's tool results: a value fetched once may be repeated on a later turn. */
  private readonly turns: (readonly OperationRecord[])[] = [];

  constructor(
    private readonly config: AgentConfig,
    private readonly agent: { now?: () => Date; events?: EventSink },
  ) {}

  /**
   * The pre-reply step's guardrail for a turn, or none for an agent without one. The turn's tool
   * results, filled in as its tools run, stay readable for the rest of the call.
   */
  input(results: readonly OperationRecord[]): { guardrail?: ReplyGuardrailInput } {
    const policy = this.config.guardrail;
    if (!policy) return {};
    this.turns.push(results);
    const agent = { config: this.config, ...this.agent };
    return { guardrail: agentGuardrailInput(policy, agent, this.turns, this.metrics) };
  }
}
