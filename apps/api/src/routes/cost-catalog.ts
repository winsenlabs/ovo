import {
  diffVendorCatalog,
  type CostLedgerService,
  type PriceCardVersion,
} from '@winsendotai/ovo-plugin-ledger';

/**
 * `GET /v1/cost/price-catalog` items: each catalog entry with its import state in this ledger as
 * `state` (`not_imported` | `imported` | `update_available`), the field name every OVO status
 * response uses. `status` carries the same value for clients written against it.
 */
export async function priceCatalog(ledger: Pick<CostLedgerService, 'listPriceCards'>) {
  return diffVendorCatalog(await allPriceCards(ledger)).map((item) => ({
    ...item,
    state: item.status,
  }));
}

/** Every stored price card; the catalog diff compares against all versions, not one page. */
async function allPriceCards(
  ledger: Pick<CostLedgerService, 'listPriceCards'>,
): Promise<PriceCardVersion[]> {
  const cards: PriceCardVersion[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await ledger.listPriceCards(100, cursor);
    cards.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return cards;
}
