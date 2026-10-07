import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ComplianceCategory } from '@winsendotai/ovo-contracts';
import { normalizePhoneNumber } from '../csv.ts';
import { seriesOf, type CliSeries } from './rule-packs.ts';

export type CliStatus = 'active' | 'suspended' | 'flagged' | 'retired';

export interface CliNumberInput {
  phoneNumber: string;
  categories: ComplianceCategory[];
  dltEntityId?: string;
  oap?: string;
  status?: CliStatus;
  /** The telco's notice when it flags the number as suspected spam (R20). */
  flagNote?: string;
}

export interface CliNumberRecord extends Required<
  Pick<CliNumberInput, 'phoneNumber' | 'categories'>
> {
  series: CliSeries;
  dltEntityId?: string;
  oap?: string;
  status: CliStatus;
  flaggedAt?: Date;
  flagNote?: string;
  updatedAt: Date;
}

export interface A2pDeclarationInput {
  rangeStart: string;
  rangeEnd: string;
  oap: string;
  reference: string;
  declaredAt: string;
  effectiveFrom: string;
}

export interface A2pDeclarationRecord extends A2pDeclarationInput {
  id: string;
  withdrawnAt?: Date;
}

interface CliRow {
  phone_number: string;
  series: CliSeries;
  categories: ComplianceCategory[];
  dlt_entity_id: string | null;
  oap: string | null;
  status: CliStatus;
  flagged_at: Date | null;
  flag_note: string | null;
  updated_at: Date;
}

const cliFromRow = (row: CliRow): CliNumberRecord => ({
  phoneNumber: row.phone_number,
  series: row.series,
  categories: row.categories,
  ...(row.dlt_entity_id ? { dltEntityId: row.dlt_entity_id } : {}),
  ...(row.oap ? { oap: row.oap } : {}),
  status: row.status,
  ...(row.flagged_at ? { flaggedAt: row.flagged_at } : {}),
  ...(row.flag_note ? { flagNote: row.flag_note } : {}),
  updatedAt: row.updated_at,
});

/**
 * The caller-number registry and the A2P declarations filed with the originating telco (G2, R7).
 * A number's series is derived from its digits, never typed in, so it cannot be mislabelled.
 */
export class CliRegistryService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async upsert(input: CliNumberInput): Promise<CliNumberRecord> {
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    const categories = [...new Set(input.categories)].sort();
    if (!categories.length) throw new Error('A caller number needs at least one category');
    const status = input.status ?? 'active';
    const result = await this.pool.query<CliRow>(
      `INSERT INTO ovo_ops_cli_numbers (organization_id, phone_number, series, categories,
         dlt_entity_id, oap, status, flagged_at, flag_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 = 'flagged' THEN now() END, $8)
       ON CONFLICT (organization_id, phone_number) DO UPDATE SET categories = EXCLUDED.categories,
         dlt_entity_id = EXCLUDED.dlt_entity_id, oap = EXCLUDED.oap, status = EXCLUDED.status,
         flagged_at = CASE WHEN EXCLUDED.status = 'flagged'
           THEN COALESCE(ovo_ops_cli_numbers.flagged_at, now()) END,
         flag_note = EXCLUDED.flag_note, updated_at = now()
       RETURNING *`,
      [
        this.organizationId,
        phoneNumber,
        seriesOf(phoneNumber),
        categories,
        input.dltEntityId ?? null,
        input.oap ?? null,
        status,
        input.flagNote ?? null,
      ],
    );
    return cliFromRow(result.rows[0]!);
  }

  async list(): Promise<CliNumberRecord[]> {
    const result = await this.pool.query<CliRow>(
      'SELECT * FROM ovo_ops_cli_numbers WHERE organization_id = $1 ORDER BY phone_number LIMIT 500',
      [this.organizationId],
    );
    return result.rows.map(cliFromRow);
  }

  async remove(phoneNumber: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM ovo_ops_cli_numbers WHERE organization_id = $1 AND phone_number = $2',
      [this.organizationId, normalizePhoneNumber(phoneNumber)],
    );
    return result.rowCount === 1;
  }

  async declare(input: A2pDeclarationInput): Promise<A2pDeclarationRecord> {
    const rangeStart = normalizePhoneNumber(input.rangeStart);
    const rangeEnd = normalizePhoneNumber(input.rangeEnd);
    if (rangeStart.length !== rangeEnd.length || rangeEnd < rangeStart)
      throw new Error('An A2P range must run from its first to its last number, same length');
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO ovo_ops_a2p_declarations (id, organization_id, range_start, range_end, oap,
         reference, declared_at, effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        this.organizationId,
        rangeStart,
        rangeEnd,
        input.oap.trim(),
        input.reference.trim(),
        input.declaredAt,
        input.effectiveFrom,
      ],
    );
    return { ...input, rangeStart, rangeEnd, id };
  }

  async withdraw(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_ops_a2p_declarations SET withdrawn_at = COALESCE(withdrawn_at, now())
       WHERE id = $1 AND organization_id = $2`,
      [id, this.organizationId],
    );
    return result.rowCount === 1;
  }

  async declarations(): Promise<A2pDeclarationRecord[]> {
    const result = await this.pool.query<{
      id: string;
      range_start: string;
      range_end: string;
      oap: string;
      reference: string;
      declared_at: string;
      effective_from: string;
      withdrawn_at: Date | null;
    }>(
      `SELECT id, range_start, range_end, oap, reference, declared_at::text AS declared_at,
         effective_from::text AS effective_from, withdrawn_at
       FROM ovo_ops_a2p_declarations WHERE organization_id = $1 ORDER BY created_at LIMIT 500`,
      [this.organizationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      rangeStart: row.range_start,
      rangeEnd: row.range_end,
      oap: row.oap,
      reference: row.reference,
      declaredAt: row.declared_at,
      effectiveFrom: row.effective_from,
      ...(row.withdrawn_at ? { withdrawnAt: row.withdrawn_at } : {}),
    }));
  }
}
