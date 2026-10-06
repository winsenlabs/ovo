import type { PriceCardVersion } from '@winsendotai/ovo-contracts';

/** A stored price card: the model it prices (absent: any model) and whether it is a placeholder. */
export interface ModelPriceCard extends PriceCardVersion {
  model?: string;
  provisional?: boolean;
}

/** One entry of the dated vendor price catalog with its state in this ledger (OPS-14). */
export interface PriceCatalogItem {
  card: Omit<ModelPriceCard, 'provenance'>;
  meterKeys: string[];
  source: { url: string; retrievedAt: string; quote: string; note?: string };
  priceCard: ModelPriceCard;
  status: 'not_imported' | 'imported' | 'update_available';
  storedVersion?: string;
}
