import { z } from 'zod';
import { CampaignCompliance } from '@winsendotai/ovo-contracts';
import { callingWindowSchema } from './calling-window.ts';
import { complianceApiSchemas } from './compliance-api-schemas.ts';
import { MAX_DO_NOT_CALL_IMPORT } from './do-not-call.ts';

const uuid = z.uuid();
const id = z.string().min(1).max(200);
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);
const mapping = z
  .object({
    phone: z.string().min(1).max(200),
    externalId: z.string().min(1).max(200).optional(),
    variables: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.string().min(1).max(200))
      .default({}),
  })
  .strict()
  .refine(
    (value) => Object.keys(value.variables).length <= 50,
    'At most 50 variable mappings are allowed',
  );
const contact = z
  .object({
    sourceRow: z.number().int().min(1).max(10_000_000),
    phoneNumber: phone,
    externalId: z.string().max(500).optional(),
    variables: z.record(z.string().max(64), z.string().max(2_000)),
  })
  .strict()
  .refine((value) => Object.keys(value.variables).length <= 50, 'At most 50 variables are allowed');
const overflowPolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('busy'), reason: z.string().trim().min(1).max(500) }).strict(),
  z
    .object({
      kind: z.literal('wait'),
      maxWaitMs: z.number().int().min(1_000).max(300_000),
      announcement: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('callback'),
      queue: id,
      announcement: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('human'),
      target: phone,
      announcement: z.string().trim().min(1).max(1_000),
    })
    .strict(),
]);
const handoffTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phone'), value: phone }).strict(),
  z.object({ kind: z.literal('queue'), value: id }).strict(),
]);
const handoffFallback = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resume'), message: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ kind: z.literal('end'), message: z.string().trim().min(1).max(1_000) }).strict(),
  z
    .object({
      kind: z.literal('human'),
      target: id,
      message: z.string().trim().min(1).max(1_000),
    })
    .strict(),
]);

export const operationsApiSchemas = {
  uuid,
  id,
  phone,
  page: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().max(200).optional(),
    })
    .strict(),
  uuidPage: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: uuid.optional(),
    })
    .strict(),
  suppressionPage: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: phone.optional(),
    })
    .strict(),
  preview: z
    .object({
      csv: z.string().min(1).max(2_097_152),
      mapping,
      /** When given, each row's variables are checked against this release's schema. */
      releaseId: uuid.optional(),
      /** With a release, each row is also judged by the compliance gate as if dialed from here. */
      fromNumber: phone.optional(),
      compliance: CampaignCompliance.optional(),
    })
    .strict(),
  campaign: z
    .object({
      operationId: uuid,
      name: z.string().trim().min(1).max(200),
      releaseId: uuid,
      fromNumber: phone,
      schedule: z
        .object({
          localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
          timezone: z.string().min(1).max(100),
        })
        .strict(),
      perNumberAttemptLimit: z.number().int().min(1).max(100),
      maxAttemptsTotal: z.number().int().min(1).max(10_000_000),
      maxAttemptsPerLocalDay: z.number().int().min(1).max(10_000_000),
      maxConcurrency: z.number().int().min(1).max(1_000).default(1),
      activeCallPolicy: z.enum(['continue', 'request_end']),
      /** Narrows the release's calling hours; judged in the schedule timezone unless it names one. */
      callingWindow: callingWindowSchema.optional(),
      compliance: CampaignCompliance.optional(),
      contacts: z.array(contact).min(1).max(100),
    })
    .strict(),
  liveCall: z
    .object({
      operationId: uuid,
      releaseId: uuid,
      fromNumber: phone,
      to: phone,
      variables: z
        .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.string().max(2_000))
        .default({}),
      /** Runs every check a launch runs (variables, do-not-call, calling hours, carrier), dials nothing. */
      dryRun: z.boolean().default(false),
    })
    .strict()
    .refine(
      (value) => Object.keys(value.variables).length <= 50,
      'At most 50 variables are allowed',
    ),
  campaignParams: z.object({ campaignId: uuid }).strict(),
  redriveParams: z.object({ contactId: uuid }).strict(),
  redrive: z.object({ notBefore: z.iso.datetime({ offset: true }).optional() }).strict(),
  campaignCommand: z.object({ expectedVersion: z.number().int().min(1) }).strict(),
  campaignConcurrency: z
    .object({
      expectedVersion: z.number().int().min(1),
      maxConcurrency: z.number().int().min(1).max(1_000),
    })
    .strict(),
  suppression: z
    .object({ phoneNumber: phone, reason: z.string().trim().min(1).max(1_000) })
    .strict(),
  suppressionParams: z.object({ phoneNumber: phone }).strict(),
  suppressionDelete: z.object({ reason: z.string().trim().min(3).max(1_000) }).strict(),
  doNotCallImport: z
    .object({
      entries: z
        .array(
          z
            .object({
              phoneNumber: z.string().min(1).max(40),
              reason: z.string().trim().min(1).max(1_000),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_DO_NOT_CALL_IMPORT),
    })
    .strict(),
  contactPage: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.coerce.number().int().min(1).max(10_000_000).optional(),
    })
    .strict(),
  inboundPolicy: z
    .object({ expectedVersion: z.number().int().min(1).nullable(), policy: overflowPolicy })
    .strict(),
  inboundDecision: z.object({ callId: id }).strict(),
  inboundRoute: z
    .object({
      expectedVersion: z.number().int().min(1).nullable(),
      releaseId: uuid,
      variables: z
        .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.string().max(2_000))
        .default({}),
      enabled: z.boolean().default(true),
      carrierPluginId: id.nullable().optional(),
      carrierBindingId: id.nullable().optional(),
    })
    .strict()
    .refine(
      (value) => Object.keys(value.variables).length <= 50,
      'At most 50 variables are allowed',
    ),
  inboundRouteParams: z.object({ phoneNumber: phone }).strict(),
  inboundRouteDelete: z.object({ expectedVersion: z.coerce.number().int().min(1) }).strict(),
  handoff: z
    .object({
      operationId: uuid,
      callId: uuid,
      target: handoffTarget,
      fallback: handoffFallback,
      confirmationRequired: z.boolean().default(true),
    })
    .strict(),
  handoffParams: z.object({ handoffId: uuid }).strict(),
  handoffConfirmation: z.object({ accepted: z.boolean() }).strict(),
  ...complianceApiSchemas,
} as const;
