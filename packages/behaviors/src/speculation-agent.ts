import type { AgentConfig, Inference } from '@winsendotai/ovo-contracts';
import type { DecisionTurn } from './decision-gate.ts';
import type { RuledDecisionGate } from './rules-gate.ts';
import {
  SpeculativeLlm,
  type InferenceCall,
  type LlmSpeculationMetrics,
} from './speculation-llm.ts';
import { speculationPolicy, type SpeculationPolicy } from './speculation-policy.ts';
import { sessionVariables, type PartialWords } from './speculation-turn.ts';

/**
 * An agent's work ahead of the caller: decisions on partial transcripts (LAT-4) and the LLM asked
 * alongside the decision (LAT-3). It holds the policy and the LLM's metering; the decisions
 * themselves live in the gate, which owns the verdicts they stand in for.
 */
export class AgentSpeculation {
  readonly policy: SpeculationPolicy;
  readonly llm: LlmSpeculationMetrics = { started: 0, used: 0, aborted: 0, discarded: 0 };
  /** The call's variables as the last turn received them, for a partial that brings none. */
  private heard?: Record<string, unknown>;

  constructor(config: AgentConfig, override?: Partial<SpeculationPolicy>) {
    this.policy = speculationPolicy(config.decision, override);
  }

  /**
   * The gate's share of the policy. A verdict that reads the turn's retrieved passages cannot be
   * decided before they are retrieved, so such an agent does not decide on partials.
   */
  static forGate(config: AgentConfig, policy: SpeculationPolicy): SpeculationPolicy {
    const retrieves = config.knowledge && config.decision?.state.sources.includes('knowledge');
    return { ...policy, partials: policy.partials && !retrieves };
  }

  /** Every turn's variables, so a later partial can be judged with the call's own. */
  heardTurn(variables: Record<string, unknown>): void {
    this.heard = sessionVariables(variables);
  }

  /**
   * A partial transcript, handed to the gate as the turn `judge` builds for it; `judge` returns
   * undefined for words the gate would not be asked about (a repeat request, a pending
   * confirmation). Never throws: a partial that cannot be prepared is decided at the end of the
   * turn, where the same failure is handled as it always was.
   */
  prepare(
    { turnId, text, stable, variables = this.heard }: PartialWords,
    gate: RuledDecisionGate | undefined,
    judge: (text: string, variables: Record<string, unknown>) => DecisionTurn | undefined,
  ): void {
    if (!gate || !variables) return;
    try {
      const turn = judge(text, variables);
      if (turn) gate.prepare(turnId, turn, stable);
    } catch {
      // swallow-ok: see above; the turn itself reports whatever failed here.
    }
  }

  /** LAT-3 for one turn, or undefined when the agent does not ask the LLM ahead of its decision. */
  llmTurn(
    llm: Inference | undefined,
    streaming: boolean,
    signal: AbortSignal,
    request: (context: string) => InferenceCall,
  ): SpeculativeLlmTurn | undefined {
    if (!this.policy.llm || !llm) return undefined;
    return new SpeculativeLlmTurn(llm, streaming, signal, this.llm, request);
  }
}

/** One turn's speculative LLM call: started by the pre-reply step, used or aborted by the turn. */
export class SpeculativeLlmTurn {
  private call?: SpeculativeLlm;

  constructor(
    private readonly llm: Inference,
    private readonly streaming: boolean,
    private readonly signal: AbortSignal,
    private readonly metrics: LlmSpeculationMetrics,
    private readonly request: (context: string) => InferenceCall,
  ) {}

  /** Ask the LLM now, with the context the turn's reply would be given. */
  readonly start = (context: string): SpeculativeLlm =>
    (this.call = new SpeculativeLlm(
      this.llm,
      this.request(context),
      this.streaming,
      this.signal,
      this.metrics,
    ));

  /** The LLM for the turn's inference step: the call already made, when it asks the same. */
  inference(): Inference {
    return this.call?.inference() ?? this.llm;
  }

  /** The turn is over; a call it never asked for is aborted. */
  finish(): void {
    this.call?.abort('the turn did not ask the LLM');
  }
}
