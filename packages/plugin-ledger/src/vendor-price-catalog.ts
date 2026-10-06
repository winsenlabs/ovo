import catalog from '../catalog/vendor-prices.json' with { type: 'json' };
import type { PriceCardVersion } from './types.ts';

/**
 * OPS-14: dated vendor list prices with provenance (`catalog/vendor-prices.json`), so price cards
 * are imported, not typed. Every entry is the vendor's public list price on the retrieval date, in
 * the vendor's currency (non-INR cards also need an FX version). Re-check each source monthly: a
 * changed price is a new version (the catalog diff shows which stored cards are behind), never an
 * edit of an existing one.
 */
export interface VendorPriceEntry {
  /** Price-card id and version this entry imports as. */
  card: Omit<PriceCardVersion, 'provenance'>;
  /** Meter keys (plugin manifests) this card prices. */
  meterKeys: readonly string[];
  source: {
    url: string;
    /** YYYY-MM-DD the page was read. */
    retrievedAt: string;
    /** The vendor's own wording of the price, as read. */
    quote: string;
    note?: string;
  };
}

export const VENDOR_PRICE_CATALOG: readonly VendorPriceEntry[] = Object.freeze(
  catalog.entries as VendorPriceEntry[],
);

/** The price card an entry imports as; its provenance names the source, date and quote. */
export function vendorPriceCard(entry: VendorPriceEntry): PriceCardVersion {
  const { url, retrievedAt, quote, note } = entry.source;
  return {
    ...entry.card,
    provenance: `${url} (retrieved ${retrievedAt}): ${quote}${note ? `. ${note}` : ''}`,
  };
}

export type CatalogEntryStatus =
  /** No stored card has this id. */
  | 'not_imported'
  /** The stored card with this id and version is the catalog's. */
  | 'imported'
  /** Stored versions of this id exist, but not this one: the vendor price moved on. */
  | 'update_available';

/**
 * The monthly diff: for each catalog entry, whether the ledger already holds it, and the newest
 * stored version of the same id when the catalog has moved past it.
 */
export function diffVendorCatalog(
  stored: readonly Pick<PriceCardVersion, 'id' | 'version' | 'effectiveAt'>[],
  entries: readonly VendorPriceEntry[] = VENDOR_PRICE_CATALOG,
) {
  return entries.map((entry) => {
    const versions = stored.filter((card) => card.id === entry.card.id);
    const latest = versions.reduce<(typeof versions)[number] | undefined>(
      (newest, card) =>
        !newest || Date.parse(card.effectiveAt) > Date.parse(newest.effectiveAt) ? card : newest,
      undefined,
    );
    const status: CatalogEntryStatus = versions.some((card) => card.version === entry.card.version)
      ? 'imported'
      : versions.length
        ? 'update_available'
        : 'not_imported';
    return {
      ...entry,
      priceCard: vendorPriceCard(entry),
      status,
      ...(latest && status === 'update_available' ? { storedVersion: latest.version } : {}),
    };
  });
}
