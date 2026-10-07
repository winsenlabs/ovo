import { z } from 'zod';

/** The building blocks of the compliance contracts (see workspace-compliance.ts). */
export const ComplianceClock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM, 00:00 to 23:59');
export const ComplianceDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'YYYY-MM-DD');
export const CompliancePhone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 phone number');
export const complianceText = (max: number) => z.string().trim().min(1).max(max);
export const complianceCount = (max: number) => z.number().int().min(0).max(max);

/** ISO weekdays, 1 = Monday, each at most once. */
export const ComplianceWeekdays = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'days must be unique');

/** Promotional (P), service (S) and transactional (T) calls, as TCCCPR defines them. */
export const ComplianceCategory = z.enum(['promotional', 'service', 'transactional']);
export type ComplianceCategory = z.infer<typeof ComplianceCategory>;

/** `rbi_recovery` adds RBI's 08:00-19:00 recovery window (R17) on top of the category's floor. */
export const CompliancePurpose = z.enum(['rbi_recovery', 'reminder', 'onboarding', 'other']);
export type CompliancePurpose = z.infer<typeof CompliancePurpose>;

/** Which regulator the sender answers to: it picks the designated series for S/T calls (R3, R4). */
export const ComplianceRegulator = z.enum([
  'rbi',
  'sebi',
  'irdai',
  'pfrda',
  'government',
  'utilities',
  'logistics',
  'other',
]);
export type ComplianceRegulator = z.infer<typeof ComplianceRegulator>;

/** How a consent ledger entry was obtained (R9-R12). */
export const ConsentBasis = z.enum([
  'explicit_registered',
  'explicit_legacy_registered',
  'explicit_service_7d',
  'inferred_relationship',
  'inquiry_7d',
  'application_3m',
  'transaction_30min',
]);
export type ConsentBasis = z.infer<typeof ConsentBasis>;

/** What a campaign relies on; `preference_allows` is a fresh DND scrub instead of a consent row. */
export const CampaignConsentBasis = z.union([ConsentBasis, z.literal('preference_allows')]);
export type CampaignConsentBasis = z.infer<typeof CampaignConsentBasis>;

/** Where a do-not-call entry came from. */
export const SuppressionSource = z.enum([
  'manual',
  'import',
  'opt_out',
  'ncpr',
  'dlt_revocation',
  'complaint',
  'wrong_number',
  'regulator',
]);
export type SuppressionSource = z.infer<typeof SuppressionSource>;

export const SuppressionScope = z.enum(['all', 'promotional', 'purpose']);
export type SuppressionScope = z.infer<typeof SuppressionScope>;

/** One local-time band; `end` is exclusive and follows `start` on the same day. */
export const WindowRule = z
  .object({
    days: ComplianceWeekdays.optional(),
    start: ComplianceClock,
    end: ComplianceClock,
  })
  .strict()
  .refine((rule) => rule.start < rule.end, { message: 'end must be after start', path: ['end'] });
export type WindowRule = z.infer<typeof WindowRule>;

/** Calls to +91 numbers are always judged in IST, whatever `timezone` says (G5). */
export const WindowSet = z
  .object({ rules: z.array(WindowRule).min(1).max(14), timezone: complianceText(100).optional() })
  .strict();
export type WindowSet = z.infer<typeof WindowSet>;

/** Per recipient number, org-wide, across every campaign and manual call. */
export const CapPolicy = z
  .object({
    attempts: z
      .object({
        per24h: complianceCount(50),
        per7d: complianceCount(200),
        per30d: complianceCount(500),
      })
      .partial()
      .strict()
      .default({}),
    connected: z
      .object({ per24h: complianceCount(50), per7d: complianceCount(200) })
      .partial()
      .strict()
      .default({}),
    minGapMinutes: complianceCount(10_080).optional(),
  })
  .strict();
export type CapPolicy = z.infer<typeof CapPolicy>;

/** What an attempt ended as, for the retry policy (spec 3.7). */
export const RetryOutcome = z.enum([
  'busy',
  'no_answer',
  'voicemail',
  'failed',
  'abandoned',
  'cancelled',
  'unknown',
  'opted_out',
  'wrong_number',
  'refused',
  'dispute',
  'callback_requested',
  'connected',
]);
export type RetryOutcome = z.infer<typeof RetryOutcome>;

export const RetryRule = z
  .object({
    retry: z.boolean(),
    backoffMinutes: z.array(z.number().int().min(1).max(43_200)).max(5).default([]),
    maxRetries: complianceCount(5).default(0),
    /** No campaign may call the number again for this many days (a refusal's cool-off). */
    cooloffDays: complianceCount(365).optional(),
  })
  .strict();
export type RetryRule = z.infer<typeof RetryRule>;
