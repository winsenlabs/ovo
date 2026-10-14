import {
  affirmationOnly,
  agentUnclearLines,
  lowInformation,
  type InferenceRequest,
} from '@winsendotai/ovo-contracts';
import type { InferenceStepInput } from './agent-inference-step.ts';
import { AgentToolSelectionError } from './agent-tools.ts';
import { normalizeUtterance } from './rules-lexicons.ts';

/*
 * What a turn says when the LLM gives it nothing usable (P8), how it keeps the uncertainty line
 * from being said twice in a row (P10), what unclear words get instead of it (call-3 #3), and
 * when the model is asked again rather than heard saying it (Wave 12, F1).
 */

type Said = Pick<InferenceStepInput, 'config' | 'previous'>;
type Heard = Said & Pick<InferenceStepInput, 'input'>;
type Failed = Pick<InferenceStepInput, 'signal' | 'current' | 'turn' | 'log' | 'streaming'>;

/**
 * P8: true when the turn answers `error` with the uncertainty line instead of throwing it, having
 * recorded it. A barge-in or a newer turn is not a failure: the engine drops that turn's reply. A
 * model's tool misuse is always answered. A provider failure (a 5xx, a timeout, a dropped stream)
 * is answered on the voice path only, where a failed turn ends the call; a `respond` caller (an
 * evaluation, a text session) gets the error, since a budget or policy stop must stop it there.
 */
export function recovered(step: Failed, error: unknown): boolean {
  const abort = (error as { name?: unknown } | undefined)?.name === 'AbortError';
  if (step.signal.aborted || !step.current() || abort) return false;
  const { turn, log } = step;
  if (error instanceof AgentToolSelectionError) {
    if (!log.toolErrors.some((each) => each.turn === turn && each.message === error.message))
      log.toolError(turn, error.toolId, 'protocol', error.message);
    return true;
  }
  if (!step.streaming) return false;
  log.toolError(turn, '', 'inference', error instanceof Error ? error.message : String(error));
  return true;
}

/**
 * P10: the uncertainty line, unless the agent's previous turn already said it, when the caller is
 * asked to say it again instead of hearing the same line twice. Wave 12 (F1): in the agent's own
 * words for that (`askAgainLine`), the clarification only where its language has none: the
 * platform's default clarification, "Please clarify your question.", is a scripted agent's line
 * and was heard in call 8cb76efc as the answer to a clear question.
 */
export function recoveryLine(step: Said): string {
  return saidUncertainty(step) ? askAgainLine(step) : step.config.uncertainty;
}

/**
 * call-3 #3: words too unclear or too thin to answer: a yes, a backchannel, a lone name, a fragment
 * the noise cut ("हाँ।", "Hardik?", "Credit. Okay, so..."). In Maya call 6e1a4e3a the model
 * answered each with the uncertainty line, "I'm not completely sure about that. Want me to look it
 * up?", four times. A statement of two or more words is not unclear: "And in Split." after an
 * answer about Zagreb is a follow-up, and the uncertainty line can be the right answer to it.
 * Wave 12 (Maya call 8cb76efc, F1): nor is a yes to the agent's own question or offer. Turn 29's
 * "Yeah." to "Would you like more on that?" was told "Sorry, could you say that again?".
 */
export function unclearWords(step: Pick<Heard, 'input' | 'previous'>): boolean {
  return lowInformation(step.input) && !answersQuestion(step);
}

/**
 * A yes/no question or an offer: "Would you like more on that?", "Want to hear more?", "Shall I
 * check?", "Is that right?". Not "Where are you thinking of going?", which a yes does not answer.
 */
const YES_NO_OPENER =
  /^(?:would|want|wanna|do|does|did|shall|should|can|could|may|might|is|are|am|was|were|will|have|has|had|interested|need|any)\b/iu;

/** A bare yes to the yes/no question or the offer the agent's previous turn ended on. */
export function answersQuestion(step: Pick<Heard, 'input' | 'previous'>): boolean {
  if (!affirmationOnly(step.input)) return false;
  const asked = (step.previous ?? [])
    .join(' ')
    .match(/[^.!?？]*[?？]/gu)
    ?.at(-1)
    ?.trim();
  return asked !== undefined && YES_NO_OPENER.test(asked);
}

/**
 * Wave 12 (Maya call 8cb76efc, F1): the model answered words it could have answered, had it been
 * able to look them up, with the uncertainty line alone, on a request sent without the provider's
 * own tools (a web search the agent has, held back by a policy for the words: Wave 10's B1 for
 * turn 11's "Jan 12th, 2024.", said before turn 10's reply; or a yes to the agent's offer). It is
 * asked once more, with the tools and a note, instead of the caller hearing the line, or the
 * clarification it became (turn 12). Undefined when there is no such way to answer: unclear words,
 * a request already sent the tools, or a port with none.
 */
export function uncertaintyRetry(
  step: Heard & { sendsProviderTools?: (request: Omit<InferenceRequest, 'signal'>) => boolean },
  request: Omit<InferenceRequest, 'signal'>,
): { providerTools: true; note: string } | undefined {
  const sends = step.sendsProviderTools;
  if (unclearWords(step) || !sends || sends(request)) return undefined;
  if (!sends({ ...request, providerTools: true })) return undefined;
  const asked = answersQuestion(step)
    ? 'said yes to what you offered: give it to them'
    : 'can be answered: answer them';
  return {
    providerTools: true,
    note:
      `You were about to answer the caller with the line "${step.config.uncertainty}". Do not ` +
      `say it: their words ${asked}, searching the web for any fact you do not have.`,
  };
}

/** The first of `lines` the agent did not say in its previous turn: no fallback twice in a row. */
export function notAgain(step: Said, lines: readonly string[]): string {
  const before = new Set((step.previous ?? []).map(normalizeUtterance));
  return lines.find((line) => !before.has(normalizeUtterance(line))) ?? lines[0]!;
}

/** call-3 #3: asks the caller to say it again, in the agent's language, never twice the same. */
export function askAgainLine(step: Said): string {
  return notAgain(step, askAgainLines(step));
}

function askAgainLines(step: Said): string[] {
  return [...agentUnclearLines(step.config), step.config.clarification];
}

/**
 * One reply's fallback lines, sentence by sentence (`segment`, for a streamed reply) and whole
 * (`whole`):
 * - call-3 #3: on unclear words, a reply that opens with the uncertainty line becomes a request to
 *   say it again, and the line's other sentences are dropped; the line's sentences after other
 *   words ("Zagreb is magical in December. Want me to look it up?") are left to P10;
 * - P10: a sentence of the uncertainty line the previous turn already said is dropped;
 * - an ask-again line the previous turn already said becomes the next one;
 * - Wave 12 (F1): on words that can be answered, the line's sentences that open the reply are held
 *   (`held`) until the reply goes on; a reply that is only that line may be asked again.
 */
export function replyFallbacks(step: Heard): {
  segment: (segment: string) => string | undefined;
  whole: (text: string) => string;
  held: () => string | undefined;
} {
  const uncertainty = normalizeUtterance(step.config.uncertainty);
  const unclear = unclearWords(step);
  const repeated = repeatGuard(step);
  const before = new Set((step.previous ?? []).map(normalizeUtterance));
  const again = new Set(askAgainLines(step).map(normalizeUtterance));
  let askedAgain = false;
  // A sentence of this reply was kept: the uncertainty line no longer opens it.
  let spoke = false;
  // Wave 12 (F1): the uncertainty line's sentences that open a reply to words that can be
  // answered, held until the reply shows whether that is all it says (`uncertaintyRetry`).
  let held: string[] = [];
  const askAgain = () => {
    if (askedAgain) return undefined;
    askedAgain = true;
    return askAgainLine(step);
  };
  const kept = (segment: string | undefined) => {
    if (segment !== undefined) spoke = true;
    return segment;
  };
  /** The held sentences P10 keeps, said with the segment that showed the reply goes on. */
  const release = (segment: string | undefined) => {
    const lines = [...held, ...(segment === undefined ? [] : [segment])];
    held = [];
    const said = lines.map((line) => (repeated ? repeated(line) : line)).filter(Boolean);
    return said.length ? said.join(' ') : undefined;
  };
  return {
    segment(segment) {
      const said = normalizeUtterance(segment);
      if (unclear && partOf(said, uncertainty) && (askedAgain || !spoke)) return askAgain();
      if (again.has(said) && before.has(said)) return askAgain();
      if (!unclear && !spoke && partOf(said, uncertainty)) {
        held.push(segment);
        return undefined;
      }
      return kept(release(segment));
    },
    // Wave 12 (F1): a whole reply of the uncertainty line to words that can be answered stays the
    // line, unless `uncertaintyRetry` asks again; never the clarification, which told turn 12's
    // clear question about Zagreb's history "Please clarify your question."
    whole(text) {
      const said = normalizeUtterance(text);
      if (said === uncertainty) return unclear ? askAgainLine(step) : text;
      return again.has(said) && before.has(said) ? askAgainLine(step) : text;
    },
    held() {
      const lines = held;
      held = [];
      return lines.length ? lines.join(' ') : undefined;
    },
  };
}

/** A whole sentence of `line`, or three or more of its words in a row. */
function partOf(said: string, line: string): boolean {
  if (!said) return false;
  return said === line || (said.split(' ').length >= 3 && line.includes(said));
}

export function saidUncertainty(step: Said): boolean {
  const before = normalizeUtterance((step.previous ?? []).join(' '));
  const first = normalizeUtterance(sentences(step.config.uncertainty)[0] ?? '');
  return first !== '' && before.includes(first);
}

/**
 * Wave 12 (F1): no longer "or ask the caller to put their question another way", which a model
 * took as leave to ask a clear question to be clarified.
 */
export function uncertaintyNote(uncertainty: string): string {
  return (
    `Your previous reply was the line "${uncertainty}". Do not say it again now: answer from the ` +
    'facts you have or can look up; ask the caller to say it again only if you could not make out ' +
    'their words.'
  );
}

/**
 * P10: drops a sentence of the uncertainty line that the agent's previous turn already said, so
 * the caller never hears "I'm not sure about that" twice in a row. Short sentences are kept.
 */
export function repeatGuard(step: Said): ((segment: string) => string | undefined) | undefined {
  if (!saidUncertainty(step)) return undefined;
  const uncertainty = normalizeUtterance(step.config.uncertainty);
  const before = normalizeUtterance((step.previous ?? []).join(' '));
  return (segment) => {
    const said = normalizeUtterance(segment);
    const repeated =
      said.split(' ').length >= 3 && uncertainty.includes(said) && before.includes(said);
    return repeated ? undefined : segment;
  };
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim());
}
