import { z } from 'zod';

/**
 * What the reply guardrail looks for in LLM text:
 *   - `amount`: a number with a currency marker (₹4,850, Rs 500, 2 lakh rupees, $20)
 *   - `percent`: a number with `%` or "percent"
 *   - `number`: any other written-out digit run of two or more digits (an invented phone number,
 *     "within 48 hours")
 *   - `date`: a calendar date (15 March, March 15th, 15/03/2026, 2026-03-15)
 *   - `offer`: a concession term (discount, waiver, settlement, cashback, interest-free...)
 */
export const GUARDRAIL_CHECKS = ['amount', 'percent', 'number', 'date', 'offer'] as const;
export const GuardrailCheck = z.enum(GUARDRAIL_CHECKS);
export type GuardrailCheck = z.infer<typeof GuardrailCheck>;

/**
 * The LLM may only state values the call already declared (AGT-5 variables, today's dates) or the
 * agent's own authored text: briefing, lines and the `allow` list below. Anything else in a reply is
 * a finding. `flag` speaks the reply and records a `guardrail` event; `block` replaces the sentence
 * and the rest of that reply with `safeLine` before it reaches TTS. Decision `say` lines and opening
 * lines are authored, so they are never checked.
 *
 * An agent without this block is not checked at all, so a release published before it existed runs
 * exactly as it did.
 */
export const AgentGuardrailPolicy = z
  .object({
    mode: z.enum(['off', 'flag', 'block']).default('flag'),
    checks: z
      .array(GuardrailCheck)
      .min(1)
      .max(GUARDRAIL_CHECKS.length)
      .default([...GUARDRAIL_CHECKS]),
    /** Spoken instead of a blocked reply; the agent's `uncertainty` line when unset. Not a template. */
    safeLine: z.string().trim().min(1).max(1_000).optional(),
    /** Extra values the agent may always state, such as a helpline number or a fixed late fee. */
    allow: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  })
  .strict();
export type AgentGuardrailPolicy = z.infer<typeof AgentGuardrailPolicy>;
