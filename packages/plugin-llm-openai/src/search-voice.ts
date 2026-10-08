import {
  acknowledgementOnly,
  affirmationOnly,
  callerWords,
  cutOffWords,
  type InferenceRequest,
} from '@winsendotai/ovo-contracts';
import type { ActivityAnnouncement } from '@winsendotai/ovo-plugin-kit';

/**
 * Wave 8: how the model is told to use its web search, sent only with the tool. In Maya call
 * 6e1a4e3a a searched turn's first token came 4.0–7.3 s after the caller stopped (median 4.7 s),
 * with searches of 1.9–3.5 s: about 2 s went on generating after the search, and the answers that
 * followed ran to several sentences read over the caller (7 of 23 replies were cut). One search,
 * and a short answer that starts with the key fact, gives the first sentence sooner.
 */
export const SEARCH_INSTRUCTIONS =
  'Search the web only for facts that change or that you do not know, and at most once per ' +
  'reply. After searching, answer in one or two short spoken sentences that start with the key ' +
  'fact; never go through every result or name your sources.';

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

/**
 * The agent's last line offered to do something, so a bare "yes" or "sure" accepts it and may need
 * the search ("Shall I check the train times?", "Do you want me to see what the news says?"). "I
 * can't confirm that" offers nothing (call 6e1a4e3a).
 */
const OFFERED =
  /\b(?:(?:want|like|need) me to|shall i|should i|can i|could i|may i|i can(?!['’]?t\b|not\b)|i could(?!n['’]?t\b)|let me|if you(?:'d)? like|look\w* (?:\w+ )?up|check|search|find out)\b/i;

/**
 * Why the caller's words are not worth a web search, or undefined to let the model decide. Cheap
 * and conservative: only words that carry nothing to look up lose the search tool.
 * - `cut-off`: a fragment the STT cut mid-word or mid-sentence ("Can you change your...");
 * - `no-words`;
 * - `backchannel`: only a yes, no, backchannel, greeting, exclamation or thanks ("Yes.", "No,
 *   no.", "Hey.", "हाँ।", "Oh, my God.", "Thank you, Danny."), unless it is a yes to the agent's
 *   offer to look something up.
 * Anything else goes to the model with the tool, a statement too: a follow-up often names no
 * question word ("And in Split.", "Restaurants near the Colosseum.") and needs the search.
 * In the Maya calls "No, no." and "Yes." each searched for 3.8–3.9 s only to restate the previous
 * answer, and in call 6e1a4e3a "Oh, my God." searched for 2.0 s.
 */
export function unclearForSearch(
  request: Pick<InferenceRequest, 'input' | 'history'>,
): 'cut-off' | 'no-words' | 'backchannel' | undefined {
  const input = request.input.trim();
  if (cutOffWords(input)) return 'cut-off';
  if (!callerWords(input).length) return 'no-words';
  const last = [...(request.history ?? [])].reverse().find((entry) => entry.role === 'assistant');
  if (affirmationOnly(input)) return last && OFFERED.test(last.content) ? undefined : 'backchannel';
  return acknowledgementOnly(input) ? 'backchannel' : undefined;
}
