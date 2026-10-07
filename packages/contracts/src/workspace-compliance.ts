import { z } from 'zod';
import {
  CampaignConsentBasis,
  CapPolicy,
  ComplianceRegulator,
  complianceCount,
  ComplianceDate,
  CompliancePhone,
  RetryOutcome,
  RetryRule,
  complianceText,
  WindowSet,
} from './compliance-primitives.ts';

export * from './compliance-primitives.ts';

/**
 * India outbound compliance by configuration (TRAI TCCCPR 2018 as amended, RBI recovery rules).
 * The jurisdiction rule pack in plugin-operations sets the floors; everything here can only narrow
 * them. Defaults are conservative engineering choices, not legal advice: each cites the rule (R#)
 * or open question (Q#) of the compliance spec it implements, see docs/runbooks/trai-compliance.md.
 */

const CapKey = z.enum(['promotional', 'service', 'transactional', 'rbi_recovery', 'generic']);
const WindowKey = z.enum(['promotional', 'service', 'transactional', 'rbi_recovery', 'generic']);

/** The workspace's compliance settings: who the sender is, and how the rule pack is enforced. */
export const WorkspaceCompliance = z
  .object({
    rulePackVersion: z.literal('2026.10.1').default('2026.10.1'),
    sender: z
      .object({
        legalName: complianceText(200).optional(),
        dltPrincipalEntityId: complianceText(100).optional(),
        regulator: ComplianceRegulator.default('other'),
        rbiEntityClass: z
          .enum(['commercial_bank', 'large_nbfc', 'sfb', 'payments_bank', 'nbfc', 'coop', 'rrb'])
          .optional(),
      })
      .strict()
      .prefault({}),
    /** The written notice of autodialler use to the originating telco, TCCCPR Reg 4 (R6). */
    autodialerIntimation: z
      .object({
        submittedAt: ComplianceDate,
        oap: complianceText(100),
        objective: complianceText(500),
        documentRef: complianceText(200),
      })
      .strict()
      .optional(),
    enforcement: z
      .object({
        /** `warn` dials a CLI outside its designated series and records the warning (Q11). */
        series: z.enum(['refuse', 'warn']).default('refuse'),
        /** A2P declarations are required from this date (R7); it may move earlier, never later. */
        a2pDeclarationRequiredFrom: ComplianceDate.default('2026-11-17'),
        /** `monitor` records the abandoned/silent ratios without pausing campaigns (Q5). */
        abandonedBreaker: z.enum(['enforce', 'monitor']).default('enforce'),
        /** RBI recovery caps act as a floor that settings and campaigns cannot raise (Q4). */
        recoveryCapsAreFloor: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    /** Overrides of the default windows (IST for +91), each within the rule-pack floor. */
    windows: z.partialRecord(WindowKey, WindowSet).default({}),
    /** No calls on these dates (YYYY-MM-DD, or MM-DD every year) for the listed kinds (Q13). */
    blackout: z
      .object({
        dates: z
          .array(z.string().regex(/^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/))
          .max(200)
          .default(['01-26', '08-15', '10-02']),
        appliesTo: z
          .array(z.enum(['promotional', 'service', 'transactional', 'rbi_recovery']))
          .max(4)
          .default(['promotional', 'rbi_recovery']),
      })
      .strict()
      .prefault({}),
    caps: z.partialRecord(CapKey, CapPolicy).default({}),
    retry: z.partialRecord(RetryOutcome, RetryRule).default({}),
    /** Maps flow dispositions (e.g. `dispute_raised`) onto retry outcomes. */
    dispositionMap: z.record(complianceText(100), RetryOutcome).default({}),
    scrub: z
      .object({
        provider: complianceText(100).default('manual-upload'),
        maxAgeHours: complianceCount(720).default(24),
      })
      .strict()
      .prefault({}),
    /** What an in-call opt-out stops: every call, or promotional calls only (Q8). */
    optOutScope: z.enum(['all', 'promotional']).default('all'),
    /** The operator's own phones: consent, scrub, category, series and A2P checks are skipped. */
    testNumbers: z.array(CompliancePhone).max(20).default([]),
    complaintSla: z
      .object({
        ackHours: z.number().int().min(1).max(720).default(24),
        resolveDays: z.number().int().min(1).max(90).default(7),
        representBusinessDays: z.number().int().min(1).max(30).default(5),
      })
      .strict()
      .prefault({}),
    breaker: z
      .object({
        warnRatio: z.number().min(0).max(1).default(0.025),
        stopRatio: z.number().min(0).max(1).default(0.03),
        silentStopRatio: z.number().min(0).max(1).default(0.01),
        silentCallSeconds: z.number().int().min(1).max(30).default(3),
        minAttempts: z.number().int().min(1).max(10_000).default(20),
      })
      .strict()
      .prefault({}),
    /** Velocity limits on CLIs outside 140/1600/1601, to stay clear of telco AI flagging (R20). */
    pacing: z
      .object({
        otherSeriesPerHour: z.number().int().min(1).max(100_000).nullable().default(60),
        otherSeriesPerDay: z.number().int().min(1).max(1_000_000).nullable().default(300),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type WorkspaceCompliance = z.infer<typeof WorkspaceCompliance>;

/** A campaign's own compliance block: it narrows the agent's and the workspace's policy. */
export const CampaignCompliance = z
  .object({
    consentBasis: CampaignConsentBasis.optional(),
    consentScope: z
      .object({
        principalEntity: complianceText(200).optional(),
        purpose: complianceText(200).optional(),
      })
      .strict()
      .optional(),
    caps: CapPolicy.optional(),
    scrubMaxAgeHours: complianceCount(720).optional(),
  })
  .strict();
export type CampaignCompliance = z.infer<typeof CampaignCompliance>;
