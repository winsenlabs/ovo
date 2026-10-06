// Per-provider scores for the STT-10 bake-off: accuracy, how soon text arrives, and cost.
import type { Corpus, CorpusUtterance, PriceTable, ProviderId, Recording } from './types.ts';
import { bestMatch } from './wer.ts';

/** The final transcript: each segment's last final, in the order segments first finalised. */
export function finalText(recording: Recording): string {
  const finals = new Map<string, string>();
  for (const event of recording.events)
    if (event.kind === 'final') finals.set(event.segmentId, event.text);
  return [...finals.values()].join(' ').trim();
}

export interface UtteranceScore {
  utteranceId: string;
  style: CorpusUtterance['style'];
  errors: number;
  words: number;
  hypothesis: string;
  /** From the first audio byte to the first event with text; null when none came. */
  firstPartialMs: number | null;
  /** From the last audio byte to the last final; null when no final came. */
  finalLatencyMs: number | null;
  failed: boolean;
}

export function scoreRecording(utterance: CorpusUtterance, recording: Recording): UtteranceScore {
  const hypothesis = recording.error ? '' : finalText(recording);
  const { errors, words } = bestMatch(
    [utterance.reference, ...(utterance.accept ?? [])],
    hypothesis,
  );
  const first = recording.events.find((event) => event.text.trim());
  const finals = recording.events.filter((event) => event.kind === 'final' && event.text.trim());
  return {
    utteranceId: utterance.id,
    style: utterance.style,
    errors,
    words,
    hypothesis,
    firstPartialMs: first ? first.atMs : null,
    finalLatencyMs: finals.length ? finals.at(-1)!.atMs - recording.audioEndMs : null,
    failed: Boolean(recording.error),
  };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Cost of the metered usage, in the price's currency, or null when the meter is unpriced. */
export function usageCost(recording: Recording, prices: PriceTable): number | null {
  const price = prices[recording.provider];
  if (!price) return null;
  let seconds = 0;
  for (const meter of recording.usage) {
    if (meter.unit !== price.unit) return null;
    seconds += Number(meter.quantity);
  }
  return (seconds / 3600) * price.perHour;
}

export interface ProviderSummary {
  provider: ProviderId;
  model: string;
  utterances: number;
  failures: number;
  /** Corpus-level WER: all errors over all reference words. */
  wer: number;
  werByStyle: Partial<Record<CorpusUtterance['style'], number>>;
  firstPartialP50Ms: number | null;
  firstPartialP95Ms: number | null;
  finalLatencyP50Ms: number | null;
  finalLatencyP95Ms: number | null;
  /** Billed cost per hour of caller audio, in INR; null when any meter is unpriced. */
  inrPerAudioHour: number | null;
  scores: UtteranceScore[];
}

function wer(scores: readonly UtteranceScore[]): number {
  const words = scores.reduce((sum, score) => sum + score.words, 0);
  return words ? scores.reduce((sum, score) => sum + score.errors, 0) / words : 0;
}

/** Scores every recording of `provider` against the corpus; recordings of unknown ids are refused. */
export function summarize(
  corpus: Corpus,
  provider: ProviderId,
  recordings: readonly Recording[],
  prices: PriceTable,
  usdInr: number,
): ProviderSummary {
  const byId = new Map(corpus.utterances.map((utterance) => [utterance.id, utterance]));
  const mine = recordings.filter((recording) => recording.provider === provider);
  const scores = mine.map((recording) => {
    const utterance = byId.get(recording.utteranceId);
    if (!utterance) throw new Error(`${provider}: no corpus utterance ${recording.utteranceId}`);
    return scoreRecording(utterance, recording);
  });
  const known = (values: (number | null)[]) => values.filter((v): v is number => v !== null);
  const partials = known(scores.map((score) => score.firstPartialMs));
  const finals = known(scores.map((score) => score.finalLatencyMs));
  const costs = mine.map((recording) => usageCost(recording, prices));
  const audioHours = mine.reduce((sum, recording) => sum + recording.audioEndMs, 0) / 3_600_000;
  const price = prices[provider];
  const toInr = price?.currency === 'USD' ? usdInr : 1;
  const styles = [...new Set(scores.map((score) => score.style))];
  return {
    provider,
    model: mine[0]?.model ?? '',
    utterances: scores.length,
    failures: scores.filter((score) => score.failed).length,
    wer: wer(scores),
    werByStyle: Object.fromEntries(
      styles.map((style) => [style, wer(scores.filter((score) => score.style === style))]),
    ),
    firstPartialP50Ms: percentile(partials, 50),
    firstPartialP95Ms: percentile(partials, 95),
    finalLatencyP50Ms: percentile(finals, 50),
    finalLatencyP95Ms: percentile(finals, 95),
    inrPerAudioHour:
      costs.length && costs.every((cost) => cost !== null) && audioHours > 0
        ? (costs.reduce<number>((sum, cost) => sum + cost!, 0) * toInr) / audioHours
        : null,
    scores,
  };
}
