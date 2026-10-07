import type { InferenceStepInput } from './agent-inference-step.ts';
import { normalizeUtterance } from './rules-lexicons.ts';

/*
 * What a turn says when the LLM gives it nothing usable (P8), and how it keeps the uncertainty line
 * from being said twice in a row (P10).
 */

type Said = Pick<InferenceStepInput, 'config' | 'previous'>;

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
