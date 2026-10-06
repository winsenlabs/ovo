import { z } from 'zod';

/**
 * What an agent says when a turn goes wrong without the LLM: the caller is silent (AGT-11), asks
 * to hear the last line again, or says something the agent did not understand (AGT-12), or the
 * decision model is down (AGT-4). Every block is optional and changes nothing when absent, so a
 * release published before these existed runs exactly as it did.
 *
 * Every line is a template like the opening's. A line with no `{{placeholder}}` never changes
 * between calls, so it is pre-rendered into the clip cache.
 */

const Line = z.string().trim().min(1).max(1_000);
const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);

/** The POC's lines (poc/lib/flow.js), which tested well on Indian English calls. */
export const DEFAULT_DIDNT_CATCH = "Sorry, I didn't quite catch that. Could you say that again?";
export const DEFAULT_REPEAT_PREFIX = 'Sure, let me repeat that.';
export const DEFAULT_GIVE_UP =
  "I'm having trouble understanding, so I'll call back later. Goodbye.";

/**
 * Per-agent caller silence handling. After the agent finishes speaking and the caller says nothing
 * for `timeoutMs`, the next prompt is spoken; once they run out, `finalLine` is spoken and the call
 * ends as `no_input`. Every line enters the conversation history, so the LLM and the decision model
 * see that the agent asked. Anything the caller says starts the escalation over.
 */
export const AgentIdle = z
  .object({
    timeoutMs: z.number().int().min(1_000).max(120_000).default(8_000),
    /** Spoken in order, one per silence ("Hello? Can you hear me?"). */
    prompts: z.array(Line).max(5).default([]),
    /** Spoken once the prompts are exhausted; the call then ends. Absent: it ends without one. */
    finalLine: Line.optional(),
  })
  .strict()
  .refine((idle) => idle.prompts.length > 0 || idle.finalLine !== undefined, {
    message: 'An idle policy needs at least one prompt or a final line',
    path: ['prompts'],
  });
export type AgentIdle = z.infer<typeof AgentIdle>;

/**
 * Recovering from a turn the agent did not understand, without the LLM: a clarify verdict, a
 * reply nothing could route, an empty transcript, or, with no LLM bound, any turn that would have
 * gone to it. Bounded: after `maxAttempts` misses in a row, `exhausted` runs.
 */
export const AgentRecovery = z
  .object({
    didntCatch: Line.default(DEFAULT_DIDNT_CATCH),
    /**
     * Re-asks keyed by flow listen set, or by decision question for an agent without a flow, spoken
     * instead of `didntCatch` while that listen set (or question) is the one that missed.
     */
    reprompts: z.record(Id, Line).default({}),
    /**
     * Replays the agent's last turn, after `prefix`, when the caller asks to hear it again: the
     * built-in `repeat` lexicon ("sorry?", "come again", "kya?") plus any extra `phrases`.
     */
    repeat: z
      .object({
        prefix: Line.default(DEFAULT_REPEAT_PREFIX),
        phrases: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
      })
      .strict()
      .optional(),
    maxAttempts: z.number().int().min(1).max(5).default(2),
    /**
     * `end` says `line` and ends the call (`completed`, reason `recovery:exhausted`). `llm` hands the
     * turn to the LLM, which then has to be bound.
     */
    exhausted: z
      .object({
        action: z.enum(['end', 'llm']).default('end'),
        line: Line.default(DEFAULT_GIVE_UP),
      })
      .strict()
      .default({ action: 'end', line: DEFAULT_GIVE_UP }),
  })
  .strict();
export type AgentRecovery = z.infer<typeof AgentRecovery>;

/**
 * The decision model timed out, errored or answered incoherently. Without this block (and without
 * `recovery`) the turn falls through to the LLM, as it always has. With it the caller hears `line`
 * (or the recovery re-ask) and the turn counts as a miss; `end` ends the call after the line.
 *
 * To hand the caller to a person instead, set `handoff.transfer.onDecisionUnavailable` (AGT-15,
 * `human-handoff.ts`); that takes precedence over this line.
 */
export const AgentDecisionUnavailable = z
  .object({
    line: Line.optional(),
    action: z.enum(['reprompt', 'end']).default('reprompt'),
  })
  .strict()
  .refine((policy) => policy.action !== 'end' || policy.line !== undefined, {
    message: 'Ending the call when the decision is unavailable needs the line to end on',
    path: ['line'],
  });
export type AgentDecisionUnavailable = z.infer<typeof AgentDecisionUnavailable>;
