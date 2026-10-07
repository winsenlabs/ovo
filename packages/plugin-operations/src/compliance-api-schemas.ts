import { z } from 'zod';
import {
  CampaignCompliance,
  ComplianceCategory,
  ConsentBasis,
  WorkspaceCompliance,
} from '@winsendotai/ovo-contracts';
import { callingWindowSchema } from './calling-window.ts';
import { MAX_PREFERENCE_UPLOAD } from './compliance/preferences.ts';

const uuid = z.uuid();
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.iso.datetime({ offset: true });

/** Request bodies of the compliance routes (settings, registries, consent, scrub, complaints). */
export const complianceApiSchemas = {
  complianceSettings: z
    .object({ expectedVersion: z.number().int().min(0), settings: WorkspaceCompliance })
    .strict(),
  cliNumber: z
    .object({
      categories: z.array(ComplianceCategory).min(1).max(3),
      dltEntityId: text(100).optional(),
      oap: text(100).optional(),
      status: z.enum(['active', 'suspended', 'flagged', 'retired']).default('active'),
      flagNote: text(1_000).optional(),
    })
    .strict(),
  a2pDeclaration: z
    .object({
      rangeStart: phone,
      rangeEnd: phone,
      oap: text(100),
      reference: text(200),
      declaredAt: isoDate,
      effectiveFrom: isoDate,
    })
    .strict(),
  consent: z
    .object({
      phoneNumber: phone,
      principalEntity: text(200),
      purpose: text(200),
      category: ComplianceCategory,
      basis: ConsentBasis,
      evidenceRef: text(200),
      obtainedAt: instant,
      customerInitiated: z.boolean().default(false),
    })
    .strict(),
  consentRevoke: z
    .object({ source: z.enum(['manual', 'dlt', 'complaint']), ref: text(200).optional() })
    .strict(),
  phoneQuery: z.object({ phoneNumber: phone }).strict(),
  preferenceUpload: z
    .object({
      provider: text(100).default('manual-upload'),
      rows: z
        .array(
          z
            .object({
              phoneNumber: phone,
              result: z.enum(['allowed', 'blocked', 'fully_blocked', 'unknown']),
              blockedCategories: z.array(z.number().int().min(1).max(8)).max(8).optional(),
              blockedTimeBands: z.array(z.number().int().min(1).max(10)).max(10).optional(),
              blockedDayTypes: z.array(z.number().int().min(1).max(10)).max(10).optional(),
              checkedAt: instant.optional(),
              ref: text(200).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_PREFERENCE_UPLOAD),
    })
    .strict(),
  complaint: z
    .object({
      kind: z.enum(['customer', 'oap_notice', 'ai_flag_notice', 'appeal', 'regulator']),
      phoneNumber: phone.optional(),
      cli: phone.optional(),
      callId: text(200).optional(),
      receivedAt: instant,
      channel: text(100).optional(),
      oapRef: text(200).optional(),
      summary: text(2_000).optional(),
      suppress: z.boolean().optional(),
    })
    .strict(),
  complaintTransition: z
    .object({
      status: z.enum(['acknowledged', 'represented', 'resolved', 'closed']),
      note: text(2_000).optional(),
    })
    .strict(),
  complaintList: z.object({ status: z.enum(['active', 'all']).default('active') }).strict(),
  idParams: z.object({ id: uuid }).strict(),
  decisionQuery: z
    .object({
      phoneNumber: phone.optional(),
      campaignId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .strict(),
  exportQuery: z
    .object({
      from: instant,
      to: instant,
      phoneNumber: phone.optional(),
      campaignId: uuid.optional(),
    })
    .strict()
    .refine((value) => Date.parse(value.from) < Date.parse(value.to), 'from must be before to')
    .refine(
      (value) => Date.parse(value.to) - Date.parse(value.from) <= 400 * 86_400_000,
      'An export covers at most 400 days',
    ),
  evidenceQuery: z.object({ phoneNumber: phone, date: instant }).strict(),
  policyPreview: z
    .object({
      releaseId: uuid,
      recipient: phone.default('+919000000000'),
      callingWindow: callingWindowSchema.optional(),
      compliance: CampaignCompliance.optional(),
      scheduleTimezone: text(100).default('Asia/Kolkata'),
    })
    .strict(),
} as const;
