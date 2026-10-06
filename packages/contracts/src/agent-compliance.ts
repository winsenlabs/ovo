import { z } from 'zod';

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM, 00:00 to 23:59');

/**
 * When this agent may be dialed, in local time: campaign admission and manual dials refuse
 * outside it. `days` are ISO weekdays (1 = Monday); absent means every day. `end` is exclusive and
 * follows `start` on the same day. Absent `timezone` means the agent's `timezone`. A campaign may
 * set its own window, which then applies instead.
 */
export const AgentCallingHours = z
  .object({
    start: Clock,
    end: Clock,
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'days must be unique')
      .optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((window) => window.start < window.end, {
    message: 'end must be after start on the same day',
    path: ['end'],
  });
export type AgentCallingHours = z.infer<typeof AgentCallingHours>;

/**
 * Spoken before anything else on every call ("this call is recorded"), so the agent speaks first
 * whenever it is set. A fixed line: it is pre-rendered into the release's clip inventory.
 */
export const AgentDisclosure = z.object({ text: z.string().trim().min(1).max(500) }).strict();
export type AgentDisclosure = z.infer<typeof AgentDisclosure>;

export const DEFAULT_OPT_OUT_CLOSING_LINE =
  "Understood. We won't call this number again. Thank you, goodbye.";

/**
 * The caller asking not to be called again ("stop calling me", "mujhe call mat karo"): the number
 * goes on the do-not-call list, the closing line plays and the call ends with disposition
 * `opted_out`. Built-in English, Hinglish and Hindi phrases always apply; `phrases` adds to them.
 */
export const AgentOptOut = z
  .object({
    enabled: z.boolean().default(true),
    phrases: z.array(z.string().trim().min(2).max(120)).max(50).default([]),
    closingLine: z.string().trim().min(1).max(500).default(DEFAULT_OPT_OUT_CLOSING_LINE),
  })
  .strict();
export type AgentOptOut = z.infer<typeof AgentOptOut>;

/** Outbound collections compliance, per agent. Every block is optional and off when absent. */
export const AgentCompliance = z
  .object({
    callingHours: AgentCallingHours.optional(),
    /** Agent mode only. */
    disclosure: AgentDisclosure.optional(),
    /** Agent mode only. */
    optOut: AgentOptOut.optional(),
  })
  .strict();
export type AgentCompliance = z.infer<typeof AgentCompliance>;

/** The fixed lines a compliance block speaks, for the clip inventory. */
export function complianceLines(compliance: AgentCompliance | undefined): string[] {
  const lines: string[] = [];
  if (compliance?.disclosure) lines.push(compliance.disclosure.text);
  if (compliance?.optOut?.enabled) lines.push(compliance.optOut.closingLine);
  return lines;
}
