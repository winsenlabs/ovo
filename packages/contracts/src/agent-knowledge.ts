import { z } from 'zod';

/**
 * Per-agent grounding. The policy says WHICH sources an agent may read, how much of what comes back
 * it may use, and how weak a match it will still accept. The plugin ranks; this decides.
 *
 * It exists because the three grounding mechanisms that came before it do not scale and are not
 * queried: `faq` is matched by token overlap, and `context` is a prompt blob that fails publication
 * above its budget rather than being searched. Everything here is a budget on retrieved text, so a
 * larger corpus does not quietly become a larger prompt.
 */

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);

export const AgentKnowledgePolicy = z
  .object({
    enabled: z.boolean().default(false),
    /** Sources this agent may read. Empty means every source the selected plugin is configured with. */
    sourceIds: z.array(Id).max(50).default([]),
    /** Passages to ask for. */
    topK: z.number().int().min(1).max(50).default(4),
    /**
     * Passages below this score are discarded before anything sees them. No default: a retrieval
     * threshold nobody chose is a threshold nobody owns, and it decides what the agent treats as
     * fact.
     */
    minScore: z.number().finite().min(0).max(1),
    /**
     * Characters of retrieved text the turn may use, after the threshold. Passages are kept in rank
     * order until the budget is reached; the rest are dropped whole, never truncated mid-passage.
     */
    maxCharacters: z.number().int().min(100).max(40_000).default(4_000),
    /** Retrieval sits in front of the reply, so its latency is audible. */
    timeoutMs: z.number().int().min(50).max(10_000).default(1_000),
    /**
     * `true` fails the turn when retrieval fails, instead of answering ungrounded. For an agent whose
     * answers are only safe when grounded — a policy or a price — that is the correct trade.
     */
    requireGrounding: z.boolean().default(false),
  })
  .strict();
export type AgentKnowledgePolicy = z.infer<typeof AgentKnowledgePolicy>;
