import type { PoolClient } from 'pg';
import { convertMinor } from '../money.ts';
import type { FxVersion, PriceCardVersion } from '../types.ts';

export async function getPriceCard(
  client: PoolClient,
  id: string,
  version: string,
): Promise<PriceCardVersion> {
  const result = await client.query(
    `SELECT id,version,provider,unit,currency,minor_units_per_block,block_quantity,effective_at,provenance
     FROM ovo_cost_price_cards WHERE id=$1 AND version=$2`,
    [id, version],
  );
  if (!result.rowCount) throw new Error('Explicit price card version not found');
  const row = result.rows[0]!;
  return {
    id: row.id,
    version: row.version,
    provider: row.provider,
    unit: row.unit,
    currency: row.currency,
    minorUnitsPerBlock: row.minor_units_per_block,
    blockQuantity: row.block_quantity,
    effectiveAt: new Date(row.effective_at).toISOString(),
    provenance: row.provenance,
  };
}

export async function priceInInr(
  client: PoolClient,
  amountMinor: string,
  currency: string,
  reference?: { id: string; version: string },
): Promise<{ amountPaise: string; fx?: FxVersion }> {
  if (currency === 'INR') {
    if (reference) throw new TypeError('INR price cards must not fabricate an FX conversion');
    return { amountPaise: amountMinor };
  }
  if (!reference) throw new TypeError('Non-INR pricing requires an explicit immutable FX version');
  const result = await client.query(
    `SELECT id,version,base_currency,quote_currency,rate_numerator::text,rate_denominator::text,
            effective_at,provenance FROM ovo_cost_fx_versions WHERE id=$1 AND version=$2`,
    [reference.id, reference.version],
  );
  if (!result.rowCount || result.rows[0]!.base_currency !== currency)
    throw new TypeError('FX version does not match the charge currency');
  const row = result.rows[0]!;
  const fx: FxVersion = {
    id: row.id,
    version: row.version,
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rateNumerator: row.rate_numerator,
    rateDenominator: row.rate_denominator,
    effectiveAt: new Date(row.effective_at).toISOString(),
    provenance: row.provenance,
  };
  return { amountPaise: convertMinor(amountMinor, fx.rateNumerator, fx.rateDenominator), fx };
}

export async function convertExplicit(
  client: PoolClient,
  amount: string,
  currency: string,
  reference?: { id: string; version: string },
): Promise<string> {
  return (await priceInInr(client, amount, currency, reference)).amountPaise;
}
