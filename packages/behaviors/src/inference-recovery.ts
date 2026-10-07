import type { InferenceStepInput } from './agent-inference-step.ts';
import { AgentToolSelectionError } from './agent-tools.ts';
import { normalizeUtterance } from './rules-lexicons.ts';

/*
 * What a turn says when the LLM gives it nothing usable (P8), and how it keeps the uncertainty line
 * from being said twice in a row (P10).
 */

type Said = Pick<InferenceStepInput, 'config' | 'previous'>;
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
