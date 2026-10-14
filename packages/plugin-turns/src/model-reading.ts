import type {
  EndOfTurnModel,
  EndOfTurnRequest,
  ModelGateConfig,
  ModelGateStats,
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
