import type { InferenceRequest } from '@winsendotai/ovo-contracts';
import type { ActivityAnnouncement } from '@winsendotai/ovo-plugin-kit';

/** `webSearch.announce`: what the caller hears while a search runs, or `false` for nothing. */
export type SearchAnnounceConfig = false | Partial<ActivityAnnouncement>;

/**
 * N3, from the Maya calls of 2026-10-07: a search held the first sentence 3.9–5.0 s after the
 * caller stopped (no-search turns 1.7 s), and the generic filler, if any, ended 2–3 s before it.
 * The search line plays when the provider starts the search, so only on turns that search; the
 * second line plays if the answer has still not started 2.5 s later.
 */
export const DEFAULT_SEARCH_ANNOUNCEMENT: ActivityAnnouncement = {
  line: 'Let me look that up.',
  stillLine: 'Still checking, one moment.',
  stillAfterMs: 2_500,
};

export const SEARCH_ANNOUNCE_SCHEMA = {
  anyOf: [
    { const: false },
    {
      type: 'object',
      properties: {
        line: { type: 'string', minLength: 1, maxLength: 200 },
        stillLine: { type: 'string', minLength: 1, maxLength: 200 },
        stillAfterMs: { type: 'integer', minimum: 500, maximum: 10_000 },
      },
      additionalProperties: false,
    },
  ],
} as const;

/** The binding's announcement: the defaults, field by field, unless it is turned off. */
export function searchAnnouncement(
  config: SearchAnnounceConfig | undefined,
): ActivityAnnouncement | undefined {
  if (config === false) return undefined;
  return { ...DEFAULT_SEARCH_ANNOUNCEMENT, ...config };
}

/** A caller turn cut off mid-word or mid-sentence ("tell me about-", "Can you change your..."). */
const CUT_OFF = /(?:-|–|—|…|\.\.\.)$/u;
const WORD = /[\p{L}\p{M}]+/gu;
/** The agent's last line offered to look something up, so a bare "yes" asks for the search. */
const OFFERED = /\b(?:look\w* (?:\w+ )?up|check|search|find out)\b/i;

/**
 * Why the caller's words are too unclear to search on, or undefined to let the model decide.
 * Cheap and conservative: a cut-off fragment, no words at all, or one distinct word ("Yes.",
 * "No, no.", "Hey.", "Nee.") that does not answer an offer to look something up. In the Maya calls
 * "No, no." and "Yes." each searched for 3.8–3.9 s to restate the previous answer.
 */
export function unclearForSearch(
  request: Pick<InferenceRequest, 'input' | 'history'>,
): 'cut-off' | 'no-words' | 'one-word' | undefined {
  const input = request.input.trim();
  if (CUT_OFF.test(input)) return 'cut-off';
  const words = new Set(input.toLowerCase().match(WORD) ?? []);
  if (!words.size) return 'no-words';
  if (words.size > 1) return undefined;
  const last = [...(request.history ?? [])].reverse().find((entry) => entry.role === 'assistant');
  const offered = last && last.content.trim().endsWith('?') && OFFERED.test(last.content);
  return offered ? undefined : 'one-word';
}
