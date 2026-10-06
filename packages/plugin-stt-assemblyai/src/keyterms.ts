import type { SpeechToText } from '@winsendotai/ovo-contracts';

/**
 * keyterms_prompt takes at most 100 terms of at most 50 characters each; a longer request is refused
 * or silently ignored. https://www.assemblyai.com/docs/streaming/keyterms-prompting (retrieved
 * 2026-10-06).
 */
export const MAX_KEYTERMS = 100;
export const MAX_KEYTERM_CHARS = 50;

/** The agent's own STT settings (`voice.stt.config`) that shape a call's keyterms (STT-11). */
export interface AssemblyAiCallKeyterms {
  /** Terms every call of this agent should favour, after the binding's. */
  keyterms?: readonly string[];
  /** Call variables whose values are favoured on that call: a customer's name, a lender, a city. */
  keytermVariables?: readonly string[];
}

/**
 * The start input with this call's variables, which the host passes alongside the session language
 * (STT-11). Optional, so a host that does not pass them yet still compiles and connects.
 */
export type KeytermStart = Parameters<SpeechToText['start']>[0] & {
  variables?: Readonly<Record<string, unknown>>;
};

function lookup(variables: Readonly<Record<string, unknown>> | undefined, path: string): unknown {
  let value: unknown = variables;
  for (const key of path.split('.'))
    value =
      value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}

/**
 * The call's keyterms: the binding's, then the agent's, then the named variables' values (strings,
 * finite numbers, or arrays of them). Fixed terms come first, so a long list of call values never
 * displaces them; whole phrases are kept ("Ravi Kumar"), duplicates are dropped ignoring case, and
 * a term over the provider's limit is left out rather than cut mid-word.
 */
export function callKeyterms(
  binding: readonly string[] | undefined,
  agent: AssemblyAiCallKeyterms,
  variables: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const terms = new Map<string, string>();
  const add = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(add);
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') return;
    const term = value.trim().replace(/\s+/g, ' ');
    if (term && term.length <= MAX_KEYTERM_CHARS && !terms.has(term.toLowerCase()))
      terms.set(term.toLowerCase(), term);
  };
  [...(binding ?? []), ...(agent.keyterms ?? [])].forEach(add);
  for (const name of agent.keytermVariables ?? []) add(lookup(variables, name));
  return [...terms.values()].slice(0, MAX_KEYTERMS);
}
