import { transcriptDoubt, type TranscriptDoubt } from '@winsendotai/ovo-contracts';
import type {
  EndOfTurnModel,
  EndOfTurnRequest,
  ModelGateConfig,
  ModelGateStats,
  SpeechStop,
} from './model-gate-config.ts';
import { endsCutOff } from './transcript-text.ts';
import { answersByItself } from './utterance-end.ts';

export function emptyStats(): ModelGateStats {
  return {
    stops: 0,
    predictions: [],
    held: [],
    merged: 0,
    rechecks: [],
    released: 0,
    bypassed: { shortAnswer: 0, question: 0, language: 0, noAudio: 0 },
    timeouts: 0,
    failures: 0,
  };
}

/** A turn's words ending on a question mark (closing quotes or brackets allowed after it). */
const QUESTION = /[?？]["'”’)\]]*\s*$/u;

/**
 * What the safety rules make of the words before the model reads them: end them unread (a short
 * answer, or a question with safety.questions on), or note that they broke off (held whatever the
 * model reads).
 */
export function safetyRead(
  text: string,
  safety: ModelGateConfig['safety'],
  context: { language: string; answering: boolean },
): { bypass?: 'shortAnswer' | 'question'; brokenOff: boolean } {
  if (safety.shortAnswers && answersByItself(text, { ...context, backchannels: [] }))
    return { bypass: 'shortAnswer', brokenOff: false };
  const brokenOff = safety.brokenOff && endsCutOff(text);
  if (safety.questions && !brokenOff && QUESTION.test(text))
    return { bypass: 'question', brokenOff };
  return { brokenOff };
}

/**
 * Asks `model` once: a synchronous answer is handed on at once, a promise once it settles (and is
 * tracked in `inFlight` until then); a throw or a rejection goes to `fail`.
 */
export function predict(
  model: EndOfTurnModel,
  request: EndOfTurnRequest,
  inFlight: Set<Promise<void>>,
  read: (probability: number) => void,
  fail: () => void,
): void {
  let result: number | Promise<number>;
  try {
    result = model.predict(request);
  } catch {
    return fail();
  }
  if (typeof result === 'number') return read(result);
  const done = result.then(read, fail).finally(() => inFlight.delete(done));
  inFlight.add(done);
}

export const join = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);

/**
 * The doubt (Wave 8) over a turn joined from several of the rules' stops, as the rules would have
 * had it over one turn: words the STT doubted stay doubted (the aggregator keeps the lowest
 * confidence: one garbled segment is enough); noise only when every part was noise (a few noise
 * words beside a sentence at speaking pace are not "mostly noise"); a fragment is read again on all
 * the words.
 */
function mergedDoubt(
  doubts: readonly (TranscriptDoubt | undefined)[],
  text: string,
  language: string,
): TranscriptDoubt | undefined {
  if (doubts.length === 1) return doubts[0];
  if (doubts.includes('low-confidence')) return 'low-confidence';
  if (doubts.every((doubt) => doubt === 'low-information')) return 'low-information';
  return transcriptDoubt({ text, language });
}

/**
 * The rules' stop of a turn's latest part as the stop of the whole turn: the words of the parts it
 * was held on (`held`, whose `doubts` include this stop's), then its own. The filler line stays the
 * last stop's: whether one is due depends on how the words end.
 */
export function joinStop(
  stop: SpeechStop,
  turnId: string,
  held: { text: string; segments: number; doubts: readonly (TranscriptDoubt | undefined)[] },
  language: string,
): SpeechStop {
  const text = join(held.text, stop.input.text);
  const untrusted = mergedDoubt(held.doubts, text, language);
  const { untrusted: _last, ...rest } = stop;
  return {
    ...rest,
    turnId,
    input: { kind: 'speech', text, segments: held.segments + stop.input.segments },
    ...(untrusted ? { untrusted } : {}),
  };
}
