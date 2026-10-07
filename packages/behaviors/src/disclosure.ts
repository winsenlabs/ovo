import {
  disclosureLines,
  type AgentCompliance,
  type SpeechKindV2,
} from '@winsendotai/ovo-contracts';
import type { AuthoredLine } from './reprompt.ts';

/** Where a disclosure line is authored, for skipped-line records. */
export const DISCLOSURE_FIELD = 'compliance.disclosure';

/**
 * The opening disclosure: the optional identity and AI lines, the recording line and the opt-out
 * hint (`AgentConfig.compliance`), in that order and spoken as one line before anything else, so
 * an agent with any of them always speaks first.
 */
export function disclosureLine(config: unknown): string | undefined {
  const compliance = (config as { compliance?: AgentCompliance } | undefined)?.compliance;
  const text = disclosureLines(compliance).join(' ').trim();
  return text || undefined;
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
