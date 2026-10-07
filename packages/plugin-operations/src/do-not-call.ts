import type { Pool, PoolClient } from 'pg';
import { lockNumber, revokeForOptOut } from './compliance/consents.ts';
import type { ComplianceSettingsStore } from './compliance/settings.ts';
import { normalizePhoneNumber } from './csv.ts';
import { boundedLimit, transaction } from './database.ts';
import type { DoNotCallSource, SuppressionRecord, SuppressionScope } from './types.ts';

export const MAX_DO_NOT_CALL_IMPORT = 1_000;
/** An opt-out stays on the list, and no consent is sought again, for 90 days (TCCCPR R13). */
export const OPT_OUT_LOCK_DAYS = 90;
const KEEPS_OPT_OUT = `s.source = 'opt_out' AND EXCLUDED.source <> 'opt_out'`;
const COLUMNS =
  'phone_number, reason, source, call_id, scope, purpose, lock_until, created_at, updated_at';

interface SuppressionRow {
  phone_number: string;
  reason: string;
  source: DoNotCallSource;
  call_id: string | null;
  scope: SuppressionScope;
  purpose: string | null;
  lock_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

function recordFromRow(row: SuppressionRow): SuppressionRecord {
  return {
    phoneNumber: row.phone_number,
    reason: row.reason,
    source: row.source,
    ...(row.call_id ? { callId: row.call_id } : {}),
    scope: row.scope,
    ...(row.purpose ? { purpose: row.purpose } : {}),
    ...(row.lock_until ? { lockUntil: row.lock_until } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Removing an opt-out before its 90-day lock ends is refused, for every role (R13). */
export class DoNotCallLockedError extends Error {
  readonly code = 'opt_out_locked';
  constructor(readonly lockUntil: Date) {
    super(`This opt-out cannot be removed before ${lockUntil.toISOString()}`);
  }
}

export interface DoNotCallOptions {
  source?: DoNotCallSource;
  callId?: string;
  scope?: SuppressionScope;
  purpose?: string;
}

/**
 * The do-not-call list (the operations suppression table). Admission and dial authorization both
 * refuse a listed number; every write takes the same per-number advisory lock as authorization, so
 * a number listed while its call is being authorized is never dialed. A caller's opt-out is locked
 * for 90 days and revokes the number's consents in the same transaction.
 */
export class DoNotCallService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly settings?: ComplianceSettingsStore,
  ) {}

  async add(phoneNumber: string, reason: string, options: DoNotCallOptions = {}): Promise<void> {
    if (!reason.trim()) throw new Error('Suppression reason is required');
    const normalized = normalizePhoneNumber(phoneNumber);
    await transaction(this.pool, (client) =>
      this.upsert(client, normalized, reason.trim(), options.source ?? 'manual', options),
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
        if (await this.upsert(client, entry.phoneNumber, entry.reason, source, {})) added += 1;
      return { added, updated: unique.length - added };
    });
  }

  /**
   * Removes an entry and returns what was removed, for the audit log. An opt-out inside its lock
   * throws `DoNotCallLockedError` and stays listed.
   */
  async remove(phoneNumber: string): Promise<SuppressionRecord | undefined> {
    const normalized = normalizePhoneNumber(phoneNumber);
    return transaction(this.pool, async (client) => {
      await lockNumber(client, this.organizationId, normalized);
      const current = await client.query<SuppressionRow>(
        `SELECT ${COLUMNS} FROM ovo_ops_suppressions
         WHERE organization_id = $1 AND phone_number = $2 FOR UPDATE`,
        [this.organizationId, normalized],
      );
      const row = current.rows[0];
      if (!row) return undefined;
      if (row.lock_until && row.lock_until.getTime() > Date.now())
        throw new DoNotCallLockedError(row.lock_until);
      await client.query(
        'DELETE FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2',
        [this.organizationId, normalized],
      );
      return recordFromRow(row);
    });
  }

  async get(phoneNumber: string): Promise<SuppressionRecord | undefined> {
    const result = await this.pool.query<SuppressionRow>(
      `SELECT ${COLUMNS} FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2`,
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
      `SELECT ${COLUMNS} FROM ovo_ops_suppressions
       WHERE organization_id = $1 AND ($2::text IS NULL OR phone_number > $2)
       ORDER BY phone_number LIMIT $3`,
      [this.organizationId, afterPhone ?? null, boundedLimit(limit)],
    );
    return result.rows.map(recordFromRow);
  }

  /**
   * True when the number was not listed before. A re-listing keeps its first `created_at`, a
   * caller's own opt-out is never overwritten by another source, the broader scope wins, and a
   * lock only ever lengthens.
   */
  async upsert(
    client: PoolClient,
    phoneNumber: string,
    reason: string,
    source: DoNotCallSource,
    options: DoNotCallOptions,
  ): Promise<boolean> {
    await lockNumber(client, this.organizationId, phoneNumber);
    const optOut = source === 'opt_out';
    const optOutScope = optOut
      ? (await this.settings?.get(client))?.settings.optOutScope
      : undefined;
    const scope = options.scope ?? (optOutScope === 'promotional' ? 'promotional' : 'all');
    const result = await client.query<{ inserted: boolean }>(
      `INSERT INTO ovo_ops_suppressions AS s
         (organization_id, phone_number, reason, source, call_id, scope, purpose, lock_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
         CASE WHEN $4 = 'opt_out' THEN now() + make_interval(days => ${OPT_OUT_LOCK_DAYS}) END)
       ON CONFLICT (organization_id, phone_number) DO UPDATE SET
         reason = CASE WHEN ${KEEPS_OPT_OUT} THEN s.reason ELSE EXCLUDED.reason END,
         source = CASE WHEN ${KEEPS_OPT_OUT} THEN s.source ELSE EXCLUDED.source END,
         call_id = CASE WHEN ${KEEPS_OPT_OUT} THEN s.call_id ELSE EXCLUDED.call_id END,
         scope = CASE WHEN s.scope = 'all' OR EXCLUDED.scope = 'all' THEN 'all'
           WHEN s.scope = EXCLUDED.scope THEN s.scope ELSE 'all' END,
         purpose = CASE WHEN s.scope = 'purpose' AND EXCLUDED.scope = 'purpose'
           AND s.purpose IS NOT DISTINCT FROM EXCLUDED.purpose THEN s.purpose ELSE NULL END,
         lock_until = GREATEST(s.lock_until, EXCLUDED.lock_until),
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        this.organizationId,
        phoneNumber,
        reason,
        source,
        options.callId ?? null,
        scope,
        scope === 'purpose' ? (options.purpose ?? null) : null,
      ],
    );
    if (optOut)
      await revokeForOptOut(
        client,
        this.organizationId,
        phoneNumber,
        scope === 'promotional' ? 'promotional' : 'all',
        options.callId,
      );
    return result.rows[0]!.inserted;
  }
}
