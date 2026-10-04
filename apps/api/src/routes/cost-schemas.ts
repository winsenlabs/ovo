export { PageQuery } from './route-page-schema.ts';
import { z } from 'zod';

const Identifier = z.string().trim().min(1).max(200);
const Provenance = z.string().trim().min(1).max(2_000);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const UnsignedInteger = z.string().regex(/^(0|[1-9]\d{0,59})$/);
const PositiveInteger = UnsignedInteger.refine((value) => value !== '0');
const Decimal = z.string().regex(/^(0|[1-9]\d{0,59})(?:\.\d{1,18})?$/);
const Timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid ISO timestamp');

export const PriceCardBody = z
  .object({
    id: Identifier,
    version: Identifier,
    provider: Identifier,
    unit: Identifier,
    currency: Currency,
    minorUnitsPerBlock: Decimal,
    blockQuantity: Decimal.refine((value) => value !== '0'),
    effectiveAt: Timestamp,
    provenance: Provenance,
  })
  .strict();

export const FxVersionBody = z
  .object({
    id: Identifier,
    version: Identifier,
    baseCurrency: Currency,
    quoteCurrency: z.literal('INR'),
    rateNumerator: UnsignedInteger,
    rateDenominator: PositiveInteger,
    effectiveAt: Timestamp,
    provenance: Provenance,
  })
  .strict();

const FxReference = z
  .object({
    id: Identifier,
    version: Identifier,
    baseCurrency: Currency,
    quoteCurrency: z.literal('INR'),
    rateNumerator: UnsignedInteger,
    rateDenominator: PositiveInteger,
  })
  .strict();

export const ScenarioBody = z
  .object({
    targetRevenuePaise: UnsignedInteger,
    durationSeconds: PositiveInteger,
    components: z
      .array(
        z
          .object({
            id: Identifier,
            category: z.enum(['telephony', 'tax', 'speech-generation', 'carrier-media', 'idle']),
            amountMinor: UnsignedInteger,
            currency: Currency,
            assumption: Provenance,
            fx: FxReference.optional(),
          })
          .strict(),
      )
      .min(5)
      .max(50),
    cache: z
      .object({
        generatedUnits: Decimal,
        hitUnits: Decimal,
        generationBilledOnce: z.literal(true),
        carrierMediaStillBilled: z.literal(true),
        assumption: Provenance,
      })
      .strict(),
    marginScope: Provenance,
  })
  .strict();

export const ReconciliationBody = z
  .object({
    idempotencyKey: Identifier,
    usageId: Identifier,
    providerInvoiceId: Identifier,
    providerInvoiceLineId: Identifier,
    actualAmountMinor: UnsignedInteger,
    currency: Currency,
    fx: z.object({ id: Identifier, version: Identifier }).strict().optional(),
    occurredAt: Timestamp,
  })
  .strict();

export const BudgetBody = z
  .object({
    id: Identifier,
    limitPaise: UnsignedInteger,
    admissionOverspendPaise: UnsignedInteger,
  })
  .strict();

export const CallParams = z.object({ callId: Identifier }).strict();
