import type { SpeechKindV2 } from '@winsendotai/ovo-contracts';
import type { AuthoredLine } from './reprompt.ts';

/** Where a disclosure line is authored, for skipped-line records. */
export const DISCLOSURE_FIELD = 'compliance.disclosure';

/**
 * The recording disclosure (`AgentConfig.compliance.disclosure.text`), read structurally. It is
 * spoken before anything else on the call, so an agent with one always speaks first.
 */
export function disclosureLine(config: unknown): string | undefined {
  const text = (config as { compliance?: { disclosure?: { text?: unknown } } } | undefined)
    ?.compliance?.disclosure?.text;
  return typeof text === 'string' && text.trim() ? text : undefined;
}

/** The opening's authored lines with the disclosure first, when the agent has one. */
export function withDisclosure(config: unknown, lines: readonly AuthoredLine[]): AuthoredLine[] {
  const text = disclosureLine(config);
  return text ? [{ field: DISCLOSURE_FIELD, text }, ...lines] : [...lines];
}

/** `disclosure` speech for the disclosure line, so evidence and caching can tell it apart. */
export function disclosureSpeechKind(config: unknown, text: string): SpeechKindV2 | undefined {
  return text === disclosureLine(config) ? 'disclosure' : undefined;
}
