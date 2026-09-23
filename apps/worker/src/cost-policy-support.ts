import type { ProviderUsage } from './cost-policy-types.ts';
import { meterKey, type UsageMeter } from '@winsendotai/ovo-contracts';
import type {
  CostLedgerService,
  PriceCardVersion,
  RecordUsageInput,
  UsageSourceKind,
} from '@winsendotai/ovo-plugin-ledger';
import type { CostPolicy } from './cost-policy-types.ts';

export interface NormalizedUsage {
  meterKey: string;
  provider: string;
  providerRequestId?: string;
  sourceKind: UsageSourceKind;
  sourceEventType: string;
  sourceEventId: string;
  activity: RecordUsageInput['activity'];
  cacheDisposition: RecordUsageInput['cacheDisposition'];
  quantity: string;
  unit: string;
  occurredAt: string;
}

export function providerMeterKey(
  usage: Pick<ProviderUsage, 'provider' | 'operation' | 'unit'>,
): string {
  if (['carrier', 'stt', 'tts', 'inference'].includes(usage.operation))
    return meterKey(usage as Pick<UsageMeter, 'provider' | 'operation' | 'unit'>);
  return `${usage.provider}.${usage.operation}.${usage.unit}`;
}

export function providerSourceKind(operation: ProviderUsage['operation']): UsageSourceKind {
  if (operation === 'tts' || operation === 'streaming-tts') return 'tts-generation';
  if (operation === 'inference') return 'llm';
  if (operation === 'carrier') return 'carrier';
  return 'stt';
}

export function usageIdentity(sessionId: string, input: NormalizedUsage): string {
  return `usage:${sessionId}:${input.sourceKind}:${input.sourceEventId}:${input.unit}`;
}

export function millisecondsToSeconds(milliseconds: number): string {
  const whole = Math.floor(milliseconds / 1_000);
  const remainder = milliseconds % 1_000;
  if (!remainder) return String(whole);
  return `${whole}.${String(remainder).padStart(3, '0').replace(/0+$/, '')}`;
}

export function validatePolicy(policy: CostPolicy): void {
  if (!policy.budgetId || !/^[1-9]\d{0,59}$/.test(policy.reservationPaise))
    throw new TypeError('Cost policy budget and reservation are required');
  if (!Number.isSafeInteger(policy.maxCallSeconds) || policy.maxCallSeconds < 1)
    throw new TypeError('Cost policy maximum duration is invalid');
  const entries = Object.entries(policy.priceCards);
  if (!entries.length || entries.length > 100)
    throw new TypeError('Cost policy price map is invalid');
  for (const [key, reference] of entries)
    if (!key || !reference.id || !reference.version)
      throw new TypeError('Cost policy price reference is invalid');
}

export async function loadCostCatalog(
  ledger: CostLedgerService,
  policy: CostPolicy,
  requiredMeterKeys: readonly string[],
): Promise<Map<string, PriceCardVersion>> {
  const cards = new Map<string, PriceCardVersion>();
  for (const meterKey of new Set(requiredMeterKeys))
    if (!policy.priceCards[meterKey]) throw new Error(`Cost meter is not configured: ${meterKey}`);
  for (const [meterKey, reference] of Object.entries(policy.priceCards)) {
    const card = await ledger.getPriceCard(reference.id, reference.version);
    if (!card) throw new Error(`Cost price version is unavailable: ${meterKey}`);
    const hasFxId = reference.fxId !== undefined;
    const hasFxVersion = reference.fxVersion !== undefined;
    if (hasFxId !== hasFxVersion) throw new Error(`Cost FX reference is incomplete: ${meterKey}`);
    if (card.currency === 'INR' && hasFxId)
      throw new Error(`INR cost meter must not include FX: ${meterKey}`);
    if (card.currency !== 'INR') {
      if (!reference.fxId || !reference.fxVersion)
        throw new Error(`Cost meter requires immutable FX: ${meterKey}`);
      const fx = await ledger.getFxVersion(reference.fxId, reference.fxVersion);
      if (!fx || fx.baseCurrency !== card.currency || fx.quoteCurrency !== 'INR')
        throw new Error(`Cost FX version does not match price currency: ${meterKey}`);
    }
    cards.set(meterKey, card);
  }
  return cards;
}
