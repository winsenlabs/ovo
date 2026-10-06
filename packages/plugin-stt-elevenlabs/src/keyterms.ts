import type { SpeechToText } from '@winsendotai/ovo-contracts';

/**
 * Realtime Scribe takes up to 50 keyterms of up to 20 characters each, and keyterm prompting is
 * billed as an extra. https://elevenlabs.io/docs/overview/capabilities/speech-to-text (retrieved
 * 2026-10-06).
 */
export const SCRIBE_MAX_KEYTERMS = 50;
export const SCRIBE_MAX_KEYTERM_CHARS = 20;

/** The agent's `voice.stt.config` keyterm settings (STT-11). */
export interface ScribeCallKeyterms {
  keyterms?: readonly string[];
  /** Call variables (paths such as `full_name`) whose values this call favours. */
  keytermVariables?: readonly string[];
}

/** The start input with the call's variables, which the host passes for STT-11 when it can. */
export type ScribeStart = Parameters<SpeechToText['start']>[0] & {
  variables?: Readonly<Record<string, unknown>>;
};

/** A value as candidate terms: a phrase that fits whole, else each of its words that fits. */
function candidates(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(candidates);
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : '';
  const phrase = text.trim().replace(/\s+/g, ' ');
  if (phrase.length <= SCRIBE_MAX_KEYTERM_CHARS) return phrase ? [phrase] : [];
  return phrase.split(' ').filter((word) => word.length <= SCRIBE_MAX_KEYTERM_CHARS);
}

/**
 * The call's keyterms within Scribe's limits: the binding's, the agent's, then the named call
 * variables' values. A name too long for one term ("Venkataraman Subramaniam") is favoured word by
 * word; fixed terms keep their place ahead of call values when the list is full.
 */
export function scribeKeyterms(
  binding: readonly string[] | undefined,
  agent: ScribeCallKeyterms,
  variables: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const values = (agent.keytermVariables ?? []).map((path) =>
    path
      .split('.')
      .reduce<unknown>(
        (at, key) =>
          at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined,
        variables,
      ),
  );
  const seen = new Set<string>();
  return [...(binding ?? []), ...(agent.keyterms ?? []), ...values]
    .flatMap(candidates)
    .filter((term) => !seen.has(term.toLowerCase()) && seen.add(term.toLowerCase()))
    .slice(0, SCRIBE_MAX_KEYTERMS);
}
