/**
 * How far an agent may work ahead of the caller (LAT-3, LAT-4), authored as
 * `decision.speculation`. Every field has a default, so an agent that authors nothing gets
 * speculation on partial transcripts and the LLM asked alongside the decision.
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
   * Which revisable partials are worth a decision. `sentence`: once the STT has punctuated a
   * partial in this call, only one that ends a sentence ("Yes, sir.", "Okay, stop."), not one cut
   * mid-phrase ("Can you please", "I am-"). On live Scribe calls only 4 of 27 and 7 of 57 last
   * partials equalled the final transcript, and almost all that did ended a sentence; the rest were
   * billed and thrown away. An STT that never punctuates its partials keeps the debounce alone.
   * `any`: every revision that holds for `debounceMs`. Stable words are always decided.
   */
  partialEnding: 'sentence' | 'any';
  /**
   * At most this many decision-model calls per utterance on revisable partials, however long the
   * caller talks. Stable words do not count: the turn would ask about them anyway.
   */
  maxPartialCalls: number;
  /**
   * `exact`: the final words, normalised, are the partial's. `prefix`: the final words may also
   * continue it ("haan ji" then "haan ji bolo"); the verdict was judged without the extra words.
   */
  match: 'exact' | 'prefix';
  /**
   * LAT-3: ask the LLM at the same time as the decision model, and abort it when the decision
   * answers the turn. An aborted call still costs its input tokens; on by default since
   * gpt-6-luna's price is confirmed (the `meter_uncovered` warning flags an LLM without one).
   */
  llm: boolean;
}

export const DEFAULT_SPECULATION: Readonly<SpeculationPolicy> = Object.freeze({
  partials: true,
  debounceMs: 150,
  partialEnding: 'sentence',
  maxPartialCalls: 2,
  match: 'exact',
  llm: true,
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
