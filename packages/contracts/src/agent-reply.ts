import { z } from 'zod';

/**
 * LAT-9 per agent. The first segment of a streamed reply is cut at its first clause once it holds
 * `minFirstWords` words; absent, the segmenter's default (3) applies. 0 cuts at any comma, which
 * starts audio soonest but can play a lone "Okay," followed by a gap. With no clause mark yet, it
 * is cut before a word that opens a phrase ("and", "to", "because") once it holds six words, and at
 * any break once it holds `firstPhraseWords` (default 10; 0 waits for a clause mark or 60
 * characters), never inside an amount, a name or a quote. Later segments are whole sentences.
 */
export const AgentReplyPacing = z
  .object({
    minFirstWords: z.number().int().min(0).max(12).optional(),
    firstPhraseWords: z.number().int().min(0).max(40).optional(),
    /**
     * A long voice answer stops before a sentence once it has said `maxSentences` (default 2; 0
     * never stops) or when that sentence would take it past `maxChars` (default 160), and ends
     * with `moreLine` (default "Want more detail?" for an agent whose `language` is English; none,
     * and no cap, for any other) unless it ended on a question. The first sentence is always said,
     * and none is cut. Applied where the voice path passes the agent's `language` to the reply
     * stream; a goodbye that ends the call is never capped. Wave 9: the offer is said at most
     * every other turn (a reply right after one stops where it is capped, with no offer), never
     * after a short answer (one under 60 characters says its next sentence, up to twice
     * `maxChars`), and an English agent without its own `moreLine` goes round four wordings.
     */
    maxSentences: z.number().int().min(0).max(10).optional(),
    maxChars: z.number().int().min(40).max(2_000).optional(),
    moreLine: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type AgentReplyPacing = z.infer<typeof AgentReplyPacing>;
