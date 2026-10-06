/**
 * How far an agent may work ahead of the caller (LAT-3, LAT-4), authored as
 * `decision.speculation`. Every field has a default, so an agent that authors nothing gets
 * speculation on partial transcripts and no speculative LLM.
 */
export interface SpeculationPolicy {
  /**
   * LAT-4: run the rules tier and the decision model on the caller's settled partial transcript,
   * and reuse the verdict when the final transcript says the same.
   */
  partials: boolean;
  /** How long a partial transcript must stay unchanged before a decision is started on it. */
  debounceMs: number;
  /**
   * `exact`: the final words, normalised, are the partial's. `prefix`: the final words may also
   * continue it ("haan ji" then "haan ji bolo"); the verdict was judged without the extra words.
   */
  match: 'exact' | 'prefix';
  /**
   * LAT-3: ask the LLM at the same time as the decision model, and abort it when the decision
   * answers the turn. An aborted call still costs its input tokens, so it is off until the LLM has
   * a confirmed price (the `meter_uncovered` warning says so).
   */
  llm: boolean;
}

export const DEFAULT_SPECULATION: Readonly<SpeculationPolicy> = Object.freeze({
  partials: true,
  debounceMs: 150,
  match: 'exact',
  llm: false,
});

export interface AgentSpeculationOptions {
  /** Replaces the authored policy field by field: simulations, tests, an operator kill switch. */
  speculation?: Partial<SpeculationPolicy>;
}

/** The policy an agent runs with: the authored `decision.speculation`, then any override. */
export function speculationPolicy(
  decision: unknown,
  override: Partial<SpeculationPolicy> = {},
): SpeculationPolicy {
  const authored =
    decision && typeof decision === 'object' && 'speculation' in decision
      ? (decision as { speculation?: Partial<SpeculationPolicy> }).speculation
      : undefined;
  return { ...DEFAULT_SPECULATION, ...defined(authored), ...defined(override) };
}

/** An absent field keeps the default; `{ llm: undefined }` does not switch anything off. */
function defined(fields: Partial<SpeculationPolicy> = {}): Partial<SpeculationPolicy> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
