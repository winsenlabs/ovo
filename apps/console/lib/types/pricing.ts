import type { PriceCardVersion as ContractPriceCardVersion } from '@winsendotai/ovo-contracts';
export type { FxVersion } from '@winsendotai/ovo-contracts';

/** A stored price card: the model it prices (absent: any model) and whether it is a placeholder. */
export interface PriceCardVersion extends ContractPriceCardVersion {
  model?: string;
  provisional?: boolean;
}

/** One entry of the dated vendor price catalog with its state in this ledger (OPS-14). */
export interface PriceCatalogItem {
  card: Omit<PriceCardVersion, 'provenance'>;
  meterKeys: string[];
  source: { url: string; retrievedAt: string; quote: string; note?: string };
  priceCard: PriceCardVersion;
  status: 'not_imported' | 'imported' | 'update_available';
  storedVersion?: string;
}
export interface ReconciliationResult {
  usageId: string;
  correctionId: string;
  deltaPaise: string;
  effectiveAmountPaise: string;
  state: 'reconciled';
}
