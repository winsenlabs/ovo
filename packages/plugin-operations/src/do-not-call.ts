import type { Pool, PoolClient } from 'pg';
import { normalizePhoneNumber } from './csv.ts';
import { boundedLimit, transaction } from './database.ts';
import type { DoNotCallSource, SuppressionRecord } from './types.ts';

export const MAX_DO_NOT_CALL_IMPORT = 1_000;
const KEEPS_OPT_OUT = `s.source = 'opt_out' AND EXCLUDED.source <> 'opt_out'`;

interface SuppressionRow {
  phone_number: string;
  reason: string;
  source: DoNotCallSource;
  call_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function recordFromRow(row: SuppressionRow): SuppressionRecord {
  return {
    phoneNumber: row.phone_number,
    reason: row.reason,
    source: row.source,
    ...(row.call_id ? { callId: row.call_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The do-not-call list (the operations suppression table). Admission and dial authorization both
 * refuse a listed number; every write takes the same per-number advisory lock as authorization, so
 * a number listed while its call is being authorized is never dialed.
 */
export class DoNotCallService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async add(
    phoneNumber: string,
    reason: string,
    options: { source?: DoNotCallSource; callId?: string } = {},
  ): Promise<void> {
    if (!reason.trim()) throw new Error('Suppression reason is required');
    const normalized = normalizePhoneNumber(phoneNumber);
    await transaction(this.pool, (client) =>
      this.upsert(client, normalized, reason.trim(), options.source ?? 'manual', options.callId),
    );
  }

  /** Adds up to 1,000 numbers in one transaction; returns how many were not listed before. */
  async import(
    entries: readonly { phoneNumber: string; reason: string }[],
    source: DoNotCallSource = 'import',
  ): Promise<{ added: number; updated: number }> {
    if (entries.length < 1 || entries.length > MAX_DO_NOT_CALL_IMPORT)
      throw new Error(`Import accepts 1 to ${MAX_DO_NOT_CALL_IMPORT} numbers`);
    const normalized = entries.map((entry) => {
      if (!entry.reason.trim()) throw new Error('Suppression reason is required');
      return { phoneNumber: normalizePhoneNumber(entry.phoneNumber), reason: entry.reason.trim() };
    });
    // Sorted so concurrent imports take the per-number locks in the same order.
    const unique = [
      ...new Map(normalized.map((entry) => [entry.phoneNumber, entry])).values(),
    ].sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));
    return transaction(this.pool, async (client) => {
      let added = 0;
      for (const entry of unique)
        if (await this.upsert(client, entry.phoneNumber, entry.reason, source)) added += 1;
      return { added, updated: unique.length - added };
    });
  }

  async remove(phoneNumber: string): Promise<boolean> {
    const normalized = normalizePhoneNumber(phoneNumber);
    return transaction(this.pool, async (client) => {
      await this.lock(client, normalized);
      const result = await client.query(
        'DELETE FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2',
        [this.organizationId, normalized],
      );
      return result.rowCount === 1;
    });
  }

  async get(phoneNumber: string): Promise<SuppressionRecord | undefined> {
    const result = await this.pool.query<SuppressionRow>(
      `SELECT phone_number, reason, source, call_id, created_at, updated_at
       FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2`,
      [this.organizationId, normalizePhoneNumber(phoneNumber)],
    );
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  /** Which of these numbers are listed, as normalized E.164. Invalid numbers are ignored. */
  async listed(phoneNumbers: readonly string[]): Promise<Set<string>> {
    const normalized = [
      ...new Set(
        phoneNumbers.flatMap((value) => {
          try {
            return [normalizePhoneNumber(value)];
          } catch {
            return [];
          }
        }),
      ),
    ];
    if (!normalized.length) return new Set();
    const result = await this.pool.query<{ phone_number: string }>(
      `SELECT phone_number FROM ovo_ops_suppressions
       WHERE organization_id = $1 AND phone_number = ANY($2::text[])`,
      [this.organizationId, normalized],
    );
    return new Set(result.rows.map((row) => row.phone_number));
  }

  async list(limit = 25, afterPhone?: string): Promise<SuppressionRecord[]> {
    const result = await this.pool.query<SuppressionRow>(
      `SELECT phone_number, reason, source, call_id, created_at, updated_at
       FROM ovo_ops_suppressions
       WHERE organization_id = $1 AND ($2::text IS NULL OR phone_number > $2)
       ORDER BY phone_number LIMIT $3`,
      [this.organizationId, afterPhone ?? null, boundedLimit(limit)],
    );
    return result.rows.map(recordFromRow);
  }

  private lock(client: PoolClient, phoneNumber: string) {
    return client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `ovo-ops-suppression:${this.organizationId}:${phoneNumber}`,
    ]);
  }

  /**
   * True when the number was not listed before. A re-listing keeps its first `created_at`, and a
   * caller's own opt-out is never overwritten by a manual or imported entry.
   */
  private async upsert(
    client: PoolClient,
    phoneNumber: string,
    reason: string,
    source: DoNotCallSource,
    callId?: string,
  ): Promise<boolean> {
    await this.lock(client, phoneNumber);
    const result = await client.query<{ inserted: boolean }>(
      `INSERT INTO ovo_ops_suppressions AS s (organization_id, phone_number, reason, source, call_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id, phone_number) DO UPDATE SET
         reason = CASE WHEN ${KEEPS_OPT_OUT} THEN s.reason ELSE EXCLUDED.reason END,
         source = CASE WHEN ${KEEPS_OPT_OUT} THEN s.source ELSE EXCLUDED.source END,
         call_id = CASE WHEN ${KEEPS_OPT_OUT} THEN s.call_id ELSE EXCLUDED.call_id END,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [this.organizationId, phoneNumber, reason, source, callId ?? null],
    );
    return result.rows[0]!.inserted;
  }
}
