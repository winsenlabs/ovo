import type { RecordUsageInput, RecordedUsage } from '../types.ts';
import { fingerprint } from './fingerprint.ts';

export interface ChargeRow {
  usage_id: string;
  charge_id: string;
  state: 'estimated' | 'reconciled';
  quantity: string;
  unit: string;
  native_amount_minor: string;
  native_currency: string;
  amount_paise: string;
  price_card_id: string;
  price_card_version: string;
  fx_id: string | null;
  fx_version: string | null;
}

export function usageFingerprint(input: RecordUsageInput): string {
  const { idempotencyKey: _, usageId: __, ...content } = input;
  return fingerprint(content);
}

export function mapRecorded(row: ChargeRow): RecordedUsage {
  return {
    usageId: row.usage_id,
    chargeId: row.charge_id,
    state: row.state,
    nativeQuantity: row.quantity,
    nativeUnit: row.unit,
    nativeAmountMinor: row.native_amount_minor,
    nativeCurrency: row.native_currency,
    amountPaise: row.amount_paise,
    priceCard: { id: row.price_card_id, version: row.price_card_version },
    fx: row.fx_id ? { id: row.fx_id, version: row.fx_version! } : undefined,
  };
}
