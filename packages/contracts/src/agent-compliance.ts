import { z } from 'zod';
import {
  ComplianceClock,
  ComplianceCategory,
  CompliancePurpose,
  ComplianceWeekdays,
} from './compliance-primitives.ts';

export * from './workspace-compliance.ts';
export * from './compliance-refusals.ts';
export type * from './preference-provider.ts';

/**
 * When this agent may be dialed, in local time: campaign admission and manual dials refuse
 * outside it. `days` are ISO weekdays (1 = Monday); absent means every day. `end` is exclusive and
 * follows `start` on the same day. Absent `timezone` means the agent's `timezone`; calls to +91
 * numbers are judged in IST whatever it says. A campaign may narrow this window, never widen it,
 * and the rule pack's floor (promotional 10:00-21:00, RBI recovery 08:00-19:00) always applies.
 */
export const AgentCallingHours = z
  .object({
    start: ComplianceClock,
    end: ComplianceClock,
    days: ComplianceWeekdays.optional(),
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

const Line = z.object({ text: z.string().trim().min(1).max(500) }).strict();

/**
 * Optional lines spoken before anything else, in this order: who is calling and why, that the
 * voice is an AI assistant, then the recording `disclosure`. All are off by default (Q9): no TRAI
 * rule requires them today; the AI line becomes mandatory only if the CCPA draft is notified (R28).
 */
export const AgentDisclosures = z
  .object({ identity: Line.optional(), ai: Line.optional(), optOutHint: Line.optional() })
  .strict();
export type AgentDisclosures = z.infer<typeof AgentDisclosures>;

/** Outbound collections compliance, per agent. Every block is optional and off when absent. */
export const AgentCompliance = z
  .object({
    /** Required before a +91 number is dialed (TCCCPR categories, R2-R5, R9). */
    category: ComplianceCategory.optional(),
    purpose: CompliancePurpose.optional(),
    callingHours: AgentCallingHours.optional(),
    disclosures: AgentDisclosures.optional(),
    /** Agent mode only. */
    disclosure: AgentDisclosure.optional(),
    /** Agent mode only. */
    optOut: AgentOptOut.optional(),
  })
  .strict();
export type AgentCompliance = z.infer<typeof AgentCompliance>;

/** The opening disclosure lines in the order they are spoken: identity, AI, recording, opt-out hint. */
export function disclosureLines(compliance: AgentCompliance | undefined): string[] {
  const lines = [
    compliance?.disclosures?.identity?.text,
    compliance?.disclosures?.ai?.text,
    compliance?.disclosure?.text,
    compliance?.disclosures?.optOutHint?.text,
  ];
  return lines.filter((line): line is string => !!line);
}

/** The fixed lines a compliance block speaks, for the clip inventory. */
export function complianceLines(compliance: AgentCompliance | undefined): string[] {
  const lines = disclosureLines(compliance);
  if (compliance?.optOut?.enabled) lines.push(compliance.optOut.closingLine);
  return lines;
}
