// Scores the bake-off's recordings against the gold references: accuracy, language drift, how
// long after the caller stops the final arrives, and what it costs.
import type { SttConfig } from './configs.ts';
import {
  allRegions,
  goldReferences,
  spokenLanguages,
  type GoldCall,
  type GoldRegion,
  type GoldUtterance,
} from './gold.ts';
import { misdetections } from './language.ts';
import { finalText, heardText } from './hypothesis.ts';
import type { StreamRecording, UtteranceRecording } from './stream.ts';
import {
  characterErrors,
  editDistance,
  looseWordErrors,
  normalizeWords,
  phoneticKey,
  wordErrors,
} from './text.ts';

export interface UtteranceScore {
  id: string;
  call: string;
  /** The gold language (`en`, `hi`, `mixed`…); undefined for a region without words. */
  language?: string;
  /** The gold's confidence in its own transcript; low ones are left out of the error rates. */
  confidence?: GoldUtterance['confidence'];
  speech: boolean;
  hypothesis: string;
  wordErrors: number;
  words: number;
  looseErrors: number;
  looseWords: number;
  charErrors: number;
  chars: number;
  /** Words transcribed where the caller said nothing. */
  insertions: number;
  /** The gold rendering the hypothesis came closest to (loosely), for the call-level WER. */
  reference: string;
  misdetection: string[];
  /** Last final after the speech ended; null when none came after it. */
  timeToFinalMs: number | null;
  missing: boolean;
}

const isUtterance = (region: GoldRegion): region is GoldUtterance =>
  typeof (region as GoldUtterance).text === 'string';

/** One region's transcript against the gold: errors for speech, insertions for non-speech. */
export function scoreUtterance(
  call: string,
  gold: GoldRegion,
  recording: UtteranceRecording | undefined,
): UtteranceScore {
  const speech = isUtterance(gold);
  // Speech is scored on what was committed; a region without words on anything shown at all.
  const hypothesis = recording ? (speech ? finalText(recording) : heardText(recording)) : '';
  const none = { errors: 0, length: 0, reference: '' };
  const references = speech ? goldReferences(gold) : [];
  const strict = speech ? wordErrors(references, hypothesis) : none;
  const loose = speech ? looseWordErrors(references, hypothesis) : none;
  const chars = speech ? characterErrors(references, hypothesis) : none;
  const spoken = speech ? spokenLanguages(gold) : ['en', 'hi'];
  const reasons = new Set(misdetections(hypothesis, spoken));
  for (const language of new Set(recording?.languages ?? []))
    for (const reason of misdetections('', spoken, language)) reasons.add(reason);
  const finals = (recording?.events ?? []).filter(
    (event) => event.kind === 'final' && event.text.trim(),
  );
  const last = finals.at(-1);
  return {
    id: gold.id,
    call,
    ...(speech ? { language: gold.language, confidence: gold.confidence } : {}),
    speech,
    hypothesis,
    wordErrors: strict.errors,
    words: strict.length,
    looseErrors: loose.errors,
    looseWords: loose.length,
    charErrors: chars.errors,
    chars: chars.length,
    insertions: speech ? 0 : normalizeWords(hypothesis).length,
    reference: loose.reference,
    misdetection: [...reasons],
    timeToFinalMs:
      recording && last && last.atMs >= recording.speechEndMs
        ? last.atMs - recording.speechEndMs
        : null,
    missing: !recording,
  };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export interface ConfigSummary {
  config: string;
  label: string;
  calls: string[];
  /** Gold speech utterances scored, and those the run never reached (a failed session). */
  utterances: number;
  /** Speech utterances whose gold is low-confidence: transcribed, but not in the error rates. */
  lowConfidence: number;
  missing: number;
  errors: string[];
  wer: number;
  looseWer: number;
  cer: number;
  /**
   * Loose WER of each whole call: its utterances' finals joined against their gold joined, which
   * no longer cares which utterance a late final landed in (AssemblyAI's lag moves words into the
   * next one). Low-confidence utterances and regions without words are left out on both sides.
   */
  callLooseWer: number;
  werEnglish: number | null;
  looseWerHindi: number | null;
  /** Speech utterances with an empty transcript. */
  empty: number;
  /** Words transcribed over non-speech utterances (noise, faint background talk). */
  insertions: number;
  /** Regions whose transcript is in a language the caller did not speak (script, letters, words). */
  misdetected: number;
  /** Regions where the provider reported such a language, whatever the text says. */
  reportedForeign: number;
  timeToFinalP50Ms: number | null;
  timeToFinalP90Ms: number | null;
  /** Speech utterances with no final after the speech ended. */
  noFinal: number;
  streamedSeconds: number;
  billedSeconds: number;
  runCostUsd: number;
  usdPerMinute: number;
  scores: UtteranceScore[];
}

const ratio = (errors: number, length: number) => (length ? errors / length : 0);
const REPORTED = 'provider reported';

function rates(scores: readonly UtteranceScore[]) {
  const sum = (field: keyof UtteranceScore) =>
    scores.reduce((total, score) => total + (score[field] as number), 0);
  return {
    wer: ratio(sum('wordErrors'), sum('words')),
    looseWer: ratio(sum('looseErrors'), sum('looseWords')),
    cer: ratio(sum('charErrors'), sum('chars')),
  };
}

/** One configuration over every gold call it has a recording for. */
export function summarize(
  config: SttConfig,
  golds: readonly GoldCall[],
  recordings: readonly StreamRecording[],
): ConfigSummary {
  const mine = recordings.filter((recording) => recording.config === config.id);
  const scores: UtteranceScore[] = [];
  const call = { errors: 0, length: 0 };
  const keys = (texts: string[]) =>
    normalizeWords(texts.join(' ')).map(phoneticKey).filter(Boolean);
  for (const recording of mine) {
    const gold = golds.find((candidate) => candidate.call === recording.call);
    if (!gold) continue;
    const byId = new Map(recording.utterances.map((utterance) => [utterance.id, utterance]));
    const regions = allRegions(gold);
    const mineScores = regions.map((region) =>
      scoreUtterance(gold.call, region, byId.get(region.id)),
    );
    scores.push(...mineScores);
    // Each utterance's closest rendering, so only where words landed differs from the utterance WER.
    const kept = mineScores.filter((score) => score.speech && score.confidence !== 'low');
    const reference = keys(kept.map((score) => score.reference));
    call.errors += editDistance(reference, keys(kept.map((score) => score.hypothesis)));
    call.length += reference.length;
  }
  const speech = scores.filter((score) => score.speech && score.confidence !== 'low');
  const all = rates(speech);
  const english = speech.filter((score) => score.language === 'en');
  const hindi = speech.filter((score) => score.language === 'hi' || score.language === 'mixed');
  const finals = speech
    .map((score) => score.timeToFinalMs)
    .filter((value): value is number => value !== null);
  const streamedSeconds = mine.reduce((sum, recording) => sum + recording.streamedMs, 0) / 1000;
  const billedSeconds =
    config.price.basis === 'session'
      ? mine.reduce((sum, recording) => sum + recording.sessionMs, 0) / 1000
      : streamedSeconds;
  return {
    config: config.id,
    label: config.label,
    calls: mine.map((recording) => recording.call),
    utterances: speech.length,
    lowConfidence: scores.filter((score) => score.confidence === 'low').length,
    missing: speech.filter((score) => score.missing).length,
    errors: mine.flatMap((recording) =>
      recording.error ? [`${recording.call}: ${recording.error}`] : [],
    ),
    ...all,
    callLooseWer: ratio(call.errors, call.length),
    werEnglish: english.length ? rates(english).wer : null,
    looseWerHindi: hindi.length ? rates(hindi).looseWer : null,
    empty: speech.filter((score) => !score.missing && !score.hypothesis).length,
    insertions: scores.reduce((sum, score) => sum + score.insertions, 0),
    misdetected: scores.filter((score) =>
      score.misdetection.some((reason) => !reason.startsWith(REPORTED)),
    ).length,
    reportedForeign: scores.filter((score) =>
      score.misdetection.some((reason) => reason.startsWith(REPORTED)),
    ).length,
    timeToFinalP50Ms: percentile(finals, 50),
    timeToFinalP90Ms: percentile(finals, 90),
    noFinal: speech.filter((score) => !score.missing && score.timeToFinalMs === null).length,
    streamedSeconds,
    billedSeconds,
    runCostUsd: (billedSeconds / 3600) * config.price.usdPerHour,
    usdPerMinute: config.price.usdPerHour / 60,
    scores,
  };
}
