import { agentUnclearLines, lowInformation } from '@winsendotai/ovo-contracts';
import type { InferenceStepInput } from './agent-inference-step.ts';
import { AgentToolSelectionError } from './agent-tools.ts';
import { normalizeUtterance } from './rules-lexicons.ts';

/*
 * What a turn says when the LLM gives it nothing usable (P8), how it keeps the uncertainty line
 * from being said twice in a row (P10), and what unclear words get instead of it (call-3 #3).
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
 * P10: the uncertainty line, unless the agent's previous turn already said it, when the
 * clarification asks the caller to put it another way instead of saying the same line twice.
 */
export function recoveryLine(step: Said): string {
  return saidUncertainty(step) ? step.config.clarification : step.config.uncertainty;
}

/**
 * call-3 #3: words too unclear or too thin to answer: a yes, a backchannel, a lone name, a fragment
 * the noise cut ("हाँ।", "Hardik?", "Credit. Okay, so..."). In Maya call 6e1a4e3a the model
 * answered each with the uncertainty line, "I'm not completely sure about that. Want me to look it
 * up?", four times. A statement of two or more words is not unclear: "And in Split." after an
 * answer about Zagreb is a follow-up, and the uncertainty line can be the right answer to it.
 */
export function unclearWords(step: Pick<Heard, 'input'>): boolean {
  return lowInformation(step.input);
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
 * - P10: a sentence of the uncertainty line the previous turn already said is dropped, and a whole
 *   reply that is only that line becomes the clarification;
 * - an ask-again line the previous turn already said becomes the next one.
 */
export function replyFallbacks(step: Heard): {
  segment: (segment: string) => string | undefined;
  whole: (text: string) => string;
} {
  const uncertainty = normalizeUtterance(step.config.uncertainty);
  const unclear = unclearWords(step);
  const repeated = repeatGuard(step);
  const before = new Set((step.previous ?? []).map(normalizeUtterance));
  const again = new Set(askAgainLines(step).map(normalizeUtterance));
  let askedAgain = false;
  // A sentence of this reply was kept: the uncertainty line no longer opens it.
  let spoke = false;
  const askAgain = () => {
    if (askedAgain) return undefined;
    askedAgain = true;
    return askAgainLine(step);
  };
  const kept = (segment: string | undefined) => {
    if (segment !== undefined) spoke = true;
    return segment;
  };
  return {
    segment(segment) {
      const said = normalizeUtterance(segment);
      if (unclear && partOf(said, uncertainty) && (askedAgain || !spoke)) return askAgain();
      if (again.has(said) && before.has(said)) return askAgain();
      return kept(repeated ? repeated(segment) : segment);
    },
    whole(text) {
      const said = normalizeUtterance(text);
      if (said === uncertainty)
        return unclear
          ? askAgainLine(step)
          : uncertaintyAgain(step, text)
            ? step.config.clarification
            : text;
      return again.has(said) && before.has(said) ? askAgainLine(step) : text;
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

/** P10: a whole reply that is the uncertainty line the previous turn already said. */
export function uncertaintyAgain(step: Said, text: string) {
  return (
    saidUncertainty(step) &&
    normalizeUtterance(text) === normalizeUtterance(step.config.uncertainty)
  );
}

export function uncertaintyNote(uncertainty: string): string {
  return (
    `Your previous reply was the line "${uncertainty}". Do not say it again now: answer from the ` +
    'facts you have, or ask the caller to put their question another way.'
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
