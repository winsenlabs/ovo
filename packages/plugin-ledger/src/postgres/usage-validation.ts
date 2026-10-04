import { parseDecimal } from '../money.ts';
import type { ReconcileUsageInput, RecordUsageInput } from '../types.ts';

export function validateUsage(input: RecordUsageInput): void {
  parseDecimal(input.quantity);
  if (
    ![
      'carrier',
      'media',
      'stt',
      'tts-generation',
      'llm',
      'worker',
      'network',
      'recording',
      'shared',
    ].includes(input.sourceKind) ||
    !['normal', 'failed-attempt', 'transfer', 'retry', 'startup', 'idle'].includes(
      input.activity,
    ) ||
    !['none', 'generation', 'hit'].includes(input.cacheDisposition)
  )
    throw new TypeError('Usage classification is invalid');
  if (input.sourceKind === 'tts-generation' && input.cacheDisposition === 'hit')
    throw new TypeError('A cache hit cannot create a TTS generation charge');
  for (const value of [
    input.idempotencyKey,
    input.workspaceId,
    input.sessionId,
    input.provider,
    input.sourceEventType,
    input.sourceEventId,
    input.unit,
    input.priceCard.id,
    input.priceCard.version,
  ])
    if (!value.trim()) throw new TypeError('Usage provenance fields are required');
  if (!Number.isFinite(Date.parse(input.occurredAt)))
    throw new TypeError('Usage occurredAt is invalid');
}

export function validateReconciliation(input: ReconcileUsageInput): void {
  for (const value of [
    input.idempotencyKey,
    input.workspaceId,
    input.usageId,
    input.providerInvoiceId,
    input.providerInvoiceLineId,
  ])
    if (!value.trim()) throw new TypeError('Invoice correction provenance is required');
  if (!/^[A-Z]{3}$/.test(input.currency) || !Number.isFinite(Date.parse(input.occurredAt)))
    throw new TypeError('Invoice correction currency or timestamp is invalid');
}
