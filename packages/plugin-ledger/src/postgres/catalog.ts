import type { Pool } from 'pg';
import { parseDecimal, parseMinor } from '../money.ts';
import type { FxVersion, LedgerPage, PriceCardVersion } from '../types.ts';
import { LedgerConflictError } from '../types.ts';
import { fingerprint } from './fingerprint.ts';
import { isoDate, requiredText } from './database.ts';
import { decodeCursor, pageFromRows, pageLimit } from './pagination.ts';

export class CostCatalogRepository {
  constructor(private readonly pool: Pool) {}

  async putPriceCard(card: PriceCardVersion): Promise<PriceCardVersion> {
    validatePriceCard(card);
    const normalized = { ...card, effectiveAt: isoDate(card.effectiveAt, 'effectiveAt') };
    const digest = fingerprint(normalized);
    const inserted = await this.pool.query(
      `INSERT INTO ovo_cost_price_cards
       (id,version,fingerprint,provider,unit,currency,minor_units_per_block,block_quantity,effective_at,provenance)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(id,version) DO NOTHING RETURNING id`,
      [
        normalized.id,
        normalized.version,
        digest,
        normalized.provider,
        normalized.unit,
        normalized.currency,
        normalized.minorUnitsPerBlock,
        normalized.blockQuantity,
        normalized.effectiveAt,
        normalized.provenance,
      ],
    );
    if (!inserted.rowCount)
      await this.assertFingerprint('ovo_cost_price_cards', card.id, card.version, digest);
    return normalized;
  }

  async getPriceCard(id: string, version: string): Promise<PriceCardVersion | undefined> {
    const result = await this.pool.query(
      `SELECT id,version,provider,unit,currency,minor_units_per_block,block_quantity,
              effective_at::text,provenance FROM ovo_cost_price_cards WHERE id=$1 AND version=$2`,
      [id, version],
    );
    return result.rows[0] ? mapPriceCard(result.rows[0]) : undefined;
  }

  async listPriceCards(
    limitInput?: number,
    cursorInput?: string,
  ): Promise<LedgerPage<PriceCardVersion>> {
    const limit = pageLimit(limitInput),
      cursor = decodeCursor(cursorInput);
    if (cursor && !cursor.version) throw new TypeError('Price-card cursor is invalid');
    const result = await this.pool.query(
      `SELECT id,version,provider,unit,currency,minor_units_per_block,block_quantity,
              effective_at::text,provenance,created_at::text
       FROM ovo_cost_price_cards
       ${cursor ? 'WHERE (created_at,id,version) < ($1::timestamptz,$2,$3)' : ''}
       ORDER BY created_at DESC,id DESC,version DESC
       LIMIT $${cursor ? 4 : 1}`,
      cursor ? [cursor.timestamp, cursor.id, cursor.version, limit + 1] : [limit + 1],
    );
    return pageFromRows(
      result.rows.map((row) => ({
        cursor: {
          timestamp: new Date(row.created_at).toISOString(),
          id: row.id,
          version: row.version,
        },
        row,
      })),
      limit,
      ({ row }) => mapPriceCard(row),
    );
  }

  async putFxVersion(fx: FxVersion): Promise<FxVersion> {
    validateFx(fx);
    const normalized = { ...fx, effectiveAt: isoDate(fx.effectiveAt, 'effectiveAt') };
    const digest = fingerprint(normalized);
    const inserted = await this.pool.query(
      `INSERT INTO ovo_cost_fx_versions
       (id,version,fingerprint,base_currency,quote_currency,rate_numerator,rate_denominator,effective_at,provenance)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(id,version) DO NOTHING RETURNING id`,
      [
        normalized.id,
        normalized.version,
        digest,
        normalized.baseCurrency,
        normalized.quoteCurrency,
        normalized.rateNumerator,
        normalized.rateDenominator,
        normalized.effectiveAt,
        normalized.provenance,
      ],
    );
    if (!inserted.rowCount)
      await this.assertFingerprint('ovo_cost_fx_versions', fx.id, fx.version, digest);
    return normalized;
  }

  async getFxVersion(id: string, version: string): Promise<FxVersion | undefined> {
    const result = await this.pool.query(
      `SELECT id,version,base_currency,quote_currency,rate_numerator::text,rate_denominator::text,
              effective_at::text,provenance FROM ovo_cost_fx_versions WHERE id=$1 AND version=$2`,
      [id, version],
    );
    return result.rows[0] ? mapFxVersion(result.rows[0]) : undefined;
  }

  async listFxVersions(limitInput?: number, cursorInput?: string): Promise<LedgerPage<FxVersion>> {
    const limit = pageLimit(limitInput),
      cursor = decodeCursor(cursorInput);
    if (cursor && !cursor.version) throw new TypeError('FX cursor is invalid');
    const result = await this.pool.query(
      `SELECT id,version,base_currency,quote_currency,rate_numerator::text,rate_denominator::text,
              effective_at::text,provenance,created_at::text
       FROM ovo_cost_fx_versions
       ${cursor ? 'WHERE (created_at,id,version) < ($1::timestamptz,$2,$3)' : ''}
       ORDER BY created_at DESC,id DESC,version DESC
       LIMIT $${cursor ? 4 : 1}`,
      cursor ? [cursor.timestamp, cursor.id, cursor.version, limit + 1] : [limit + 1],
    );
    return pageFromRows(
      result.rows.map((row) => ({
        cursor: {
          timestamp: new Date(row.created_at).toISOString(),
          id: row.id,
          version: row.version,
        },
        row,
      })),
      limit,
      ({ row }) => mapFxVersion(row),
    );
  }

  private async assertFingerprint(table: string, id: string, version: string, expected: string) {
    const row = await this.pool.query(
      `SELECT fingerprint FROM ${table} WHERE id=$1 AND version=$2`,
      [id, version],
    );
    if (row.rows[0]?.fingerprint !== expected)
      throw new LedgerConflictError(`Immutable ${table} version conflicts with existing content`);
  }
}

function mapPriceCard(row: any): PriceCardVersion {
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

function mapFxVersion(row: any): FxVersion {
  return {
    id: row.id,
    version: row.version,
    baseCurrency: row.base_currency,
    quoteCurrency: 'INR',
    rateNumerator: row.rate_numerator,
    rateDenominator: row.rate_denominator,
    effectiveAt: new Date(row.effective_at).toISOString(),
    provenance: row.provenance,
  };
}

function validatePriceCard(card: PriceCardVersion): void {
  for (const [name, value] of Object.entries({
    id: card.id,
    version: card.version,
    provider: card.provider,
    unit: card.unit,
    provenance: card.provenance,
  }))
    requiredText(value, name);
  if (!/^[A-Z]{3}$/.test(card.currency)) throw new TypeError('Price currency must be ISO 4217');
  parseDecimal(card.minorUnitsPerBlock);
  if (parseDecimal(card.blockQuantity).numerator <= 0n)
    throw new TypeError('Price block must be positive');
}

function validateFx(fx: FxVersion): void {
  for (const [name, value] of Object.entries({
    id: fx.id,
    version: fx.version,
    provenance: fx.provenance,
  }))
    requiredText(value, name);
  if (!/^[A-Z]{3}$/.test(fx.baseCurrency) || fx.quoteCurrency !== 'INR')
    throw new TypeError('FX must convert an ISO currency to INR');
  if (parseMinor(fx.rateNumerator) < 0n || parseMinor(fx.rateDenominator) <= 0n)
    throw new TypeError('FX rate must be nonnegative with a positive denominator');
}
