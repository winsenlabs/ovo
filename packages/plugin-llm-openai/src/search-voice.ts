import {
  acknowledgementOnly,
  affirmationOnly,
  callerWords,
  cutOffWords,
  statesPlans,
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
 * Wave 12 (Maya call 8cb76efc, F1): nor does an offer of more ("Would you like more on that?",
 * "Want to hear more?", "Interested in more detail?"), which Wave 9 (D5) took for one that needs no
 * search. Turn 29's "Yeah." to it went without the tool; the model, its sources spent, gave the
 * uncertainty line, heard as "Sorry, could you say that again?". More detail on an answer that was
 * looked up is looked up too. Only the offer counts: the agent's own request for "more details"
 * on the caller's plans offers nothing.
 */
const OFFERED =
  /\b(?:(?:want|like|need) me to|shall i|should i|can i|could i|may i|i can(?!['’]?t\b|not\b)|i could(?!n['’]?t\b)|let me|if you(?:'d)? like|look\w* (?:\w+ )?up|check|search|find out|(?:want|like|interested in) (?:to (?:hear|know|learn) )?more)\b/i;

/**
 * Wave 9 D7: the platform's own question before it ends a call ("Shall I end the call?") offers
 * nothing to look up. In call 10d5ef30 the yes to it ("Yeah, yeah, please.") went to the model with
 * the search tool, which adds about 4,300 input tokens to every request; the offer is left out
 * before the agent's last line is read for one, so a line that also offers a search keeps it.
 */
const ENDING_OFFER =
  /\b(?:shall|should|can|may) i (?:end|close|finish|hang up)(?: (?:the|this|our) call)?\b/gi;

/**
 * Why the caller's words are not worth a web search, or undefined to let the model decide. Cheap
 * and conservative: only words that carry nothing to look up lose the search tool.
 * - `cut-off`: a fragment the STT cut mid-word or mid-sentence ("Can you change your...");
 * - `no-words`;
 * - `backchannel`: only a yes, no, backchannel, greeting, exclamation or thanks ("Yes.", "No,
 *   no.", "Hey.", "हाँ।", "Oh, my God.", "Thank you, Danny."), unless it is a yes to the agent's
 *   offer to look something up.
 * - `statement`: the caller telling the agent their own plans, dates or a list of places
 *   (`statesPlans`: "I want 21st of December to the 5th.", "Germany, Berlin, and a few other
 *   places."), unless the agent's last line offered to look something up, which such words answer
 *   ("…the dates to check fares. What day would you like to leave?").
 * Anything else goes to the model with the tool, a statement too: a follow-up often names no
 * question word ("And in Split.", "Restaurants near the Colosseum.") and needs the search.
 * In the Maya calls "No, no." and "Yes." each searched for 3.8–3.9 s only to restate the previous
 * answer, in call 6e1a4e3a "Oh, my God." searched for 2.0 s, and in call e8a43f65 four statements
 * of dates and cities searched for 1.9–3.0 s each (issue 3).
 */
export function unclearForSearch(
  request: Pick<InferenceRequest, 'input' | 'history'>,
): 'cut-off' | 'no-words' | 'backchannel' | 'statement' | undefined {
  const input = request.input.trim();
  if (cutOffWords(input)) return 'cut-off';
  if (!callerWords(input).length) return 'no-words';
  const last = [...(request.history ?? [])].reverse().find((entry) => entry.role === 'assistant');
  const offered = Boolean(last && OFFERED.test(last.content.replace(ENDING_OFFER, '')));
  if (affirmationOnly(input)) return offered ? undefined : 'backchannel';
  if (acknowledgementOnly(input)) return 'backchannel';
  return statesPlans(input) && !offered ? 'statement' : undefined;
}
