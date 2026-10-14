// The scorecard's metrics: their raw counts and samples (summed and pooled across calls), and the
// numbers derived from them. One table drives the report, the diff and the regression gate.

/** Counts and samples a call contributes; an aggregate is their sum. Null: needs gold. */
export interface RawScore {
  answeredTurns: number;
  resetTurns: number;
  quickRestarts: number;
  goldThoughts: number | null;
  /** Answered turns and LLM requests of the calls with gold, the denominators of gold rates. */
  goldTurns: number | null;
  goldLlmRequests: number | null;
  splitThoughts: number | null;
  extraTurns: number | null;
  mergedThoughts: number | null;
  falseEndpoints: number | null;
  phantomTurns: number | null;
  droppedThoughts: number | null;
  discardedReplies: number;
  discardedLines: number;
  cutLines: number;
  llmRequests: number;
  talkOver: number;
  talkOverMs: number;
  missedReplies: number | null;
  missedTurnReplies: number;
  cannedLines: number;
  fillers: number;
  foreignSegments: number;
  foreignInterims: number;
  /** The caller's transcribed segments, and those no answered turn covers. */
  callerSegments: number;
  uncoveredSegments: number;
  languageMismatches: number | null;
  sttEdits: number | null;
  sttWords: number | null;
  sttCharEdits: number | null;
  sttChars: number | null;
  samples: {
    endpointMs: number[];
    firstAudioMs: number[];
    firstAnswerMs: number[];
    replyLatencyMs: number[];
  };
}

export type Metrics = Record<string, number | null>;

/** Nearest-rank percentile; null for no samples. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ]!;
}

const ratio = (num: number | null, den: number | null) =>
  num === null || den === null || den === 0 ? null : num / den;

export function metricsOf(raw: RawScore): Metrics {
  const { samples } = raw;
  return {
    answeredTurns: raw.answeredTurns,
    resetTurns: raw.resetTurns,
    quickRestarts: raw.quickRestarts,
    goldThoughts: raw.goldThoughts,
    splitRate: ratio(raw.splitThoughts, raw.goldThoughts),
    extraTurns: raw.extraTurns,
    mergeRate: ratio(raw.mergedThoughts, raw.goldThoughts),
    falseEndpoints: raw.falseEndpoints,
    falseEndpointRate: ratio(raw.falseEndpoints, raw.goldTurns),
    phantomTurns: raw.phantomTurns,
    droppedThoughts: raw.droppedThoughts,
    endpointP50Ms: percentile(samples.endpointMs, 50),
    endpointP90Ms: percentile(samples.endpointMs, 90),
    discardedReplies: raw.discardedReplies,
    discardedLines: raw.discardedLines,
    cutLines: raw.cutLines,
    llmRequests: raw.llmRequests,
    llmPerThought: ratio(raw.goldLlmRequests, raw.goldThoughts),
    llmPerTurn: ratio(raw.llmRequests, raw.answeredTurns),
    talkOver: raw.talkOver,
    talkOverMs: raw.talkOverMs,
    missedReplies: raw.missedReplies,
    missedTurnReplies: raw.missedTurnReplies,
    cannedLines: raw.cannedLines,
    fillers: raw.fillers,
    firstAudioP50Ms: percentile(samples.firstAudioMs, 50),
    firstAudioP90Ms: percentile(samples.firstAudioMs, 90),
    firstAnswerP50Ms: percentile(samples.firstAnswerMs, 50),
    firstAnswerP90Ms: percentile(samples.firstAnswerMs, 90),
    replyLatencyP50Ms: percentile(samples.replyLatencyMs, 50),
    replyLatencyP90Ms: percentile(samples.replyLatencyMs, 90),
    wer: ratio(raw.sttEdits, raw.sttWords),
    cer: ratio(raw.sttCharEdits, raw.sttChars),
    foreignSegments: raw.foreignSegments,
    foreignInterims: raw.foreignInterims,
    uncoveredSegments: raw.uncoveredSegments,
    uncoveredSegmentRate: ratio(raw.uncoveredSegments, raw.callerSegments),
    languageMismatches: raw.languageMismatches,
  };
}

/** Sums calls' raw scores; a gold-only count stays null unless some call had gold. */
export function sumRaw(raws: readonly RawScore[]): RawScore {
  const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  const total = structuredClone(raws[0] ?? emptyRaw());
  for (const raw of raws.slice(1)) {
    for (const key of Object.keys(raw) as (keyof RawScore)[]) {
      if (key === 'samples') continue;
      (total[key] as number | null) = add(total[key] as number | null, raw[key] as number | null);
    }
    for (const key of Object.keys(raw.samples) as (keyof RawScore['samples'])[])
      total.samples[key].push(...raw.samples[key]);
  }
  return total;
}

export function emptyRaw(): RawScore {
  return {
    answeredTurns: 0,
    resetTurns: 0,
    quickRestarts: 0,
    goldThoughts: null,
    goldTurns: null,
    goldLlmRequests: null,
    splitThoughts: null,
    extraTurns: null,
    mergedThoughts: null,
    falseEndpoints: null,
    phantomTurns: null,
    droppedThoughts: null,
    discardedReplies: 0,
    discardedLines: 0,
    cutLines: 0,
    llmRequests: 0,
    talkOver: 0,
    talkOverMs: 0,
    missedReplies: null,
    missedTurnReplies: 0,
    cannedLines: 0,
    fillers: 0,
    foreignSegments: 0,
    foreignInterims: 0,
    callerSegments: 0,
    uncoveredSegments: 0,
    languageMismatches: null,
    sttEdits: null,
    sttWords: null,
    sttCharEdits: null,
    sttChars: null,
    samples: { endpointMs: [], firstAudioMs: [], firstAnswerMs: [], replyLatencyMs: [] },
  };
}
