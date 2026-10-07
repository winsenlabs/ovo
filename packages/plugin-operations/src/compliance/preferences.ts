import type { Pool } from 'pg';
import type { PreferenceCheck, PreferenceProvider } from '@winsendotai/ovo-contracts';
import { normalizePhoneNumber } from '../csv.ts';
import { transaction } from '../database.ts';
import { DoNotCallService } from '../do-not-call.ts';
import type { Database } from '../types.ts';

export const MANUAL_UPLOAD_PROVIDER = 'manual-upload';
export const MAX_PREFERENCE_UPLOAD = 5_000;

export interface PreferenceUploadRow extends PreferenceCheck {
  /** When the telco or RTM portal ran the check; defaults to the upload time. */
  checkedAt?: Date;
}

/**
 * DND / NCPR scrub results (G8, R14): uploaded by hand from the telemarketer's or telco's portal
 * (`manual-upload`), or fetched by a vendor provider plugin when one is configured. A promotional
 * call with no fresh `allowed` result is refused (fail closed).
 */
export class PreferenceService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly providers: ReadonlyMap<string, PreferenceProvider> = new Map(),
    private readonly doNotCall?: DoNotCallService,
  ) {}

  /** The provider ids a workspace may select: the manual upload and every configured plugin. */
  providerIds(): string[] {
    return [MANUAL_UPLOAD_PROVIDER, ...this.providers.keys()];
  }

  /**
   * Stores uploaded results; a fully blocked number is also put on the do-not-call list for
   * promotional calls (`ncpr`), so the scrub outlives its freshness window.
   */
  async upload(
    rows: readonly PreferenceUploadRow[],
    provider = MANUAL_UPLOAD_PROVIDER,
  ): Promise<{ stored: number; ncprListed: number }> {
    if (rows.length < 1 || rows.length > MAX_PREFERENCE_UPLOAD)
      throw new Error(`Upload accepts 1 to ${MAX_PREFERENCE_UPLOAD} results`);
    const normalized = rows.map((row) => ({
      ...row,
      phoneNumber: normalizePhoneNumber(row.phoneNumber),
    }));
    return transaction(this.pool, async (client) => {
      for (const row of normalized) await this.store(client, row, provider);
      let ncprListed = 0;
      for (const row of normalized.filter((candidate) => candidate.result === 'fully_blocked')) {
        await this.doNotCall?.upsert(client, row.phoneNumber, 'NCPR fully blocked', 'ncpr', {
          scope: 'promotional',
        });
        ncprListed += this.doNotCall ? 1 : 0;
      }
      return { stored: normalized.length, ncprListed };
    });
  }

  /** Re-checks numbers through a vendor provider when their cached result is stale. */
  async refresh(
    db: Database,
    providerId: string,
    numbers: readonly string[],
    category: 'promotional' | 'service',
    now = new Date(),
  ): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider || !numbers.length) return;
    const fresh = await db.query<{ phone_number: string }>(
      `SELECT phone_number FROM ovo_ops_preference_checks WHERE organization_id = $1
         AND provider = $2 AND phone_number = ANY($3::text[])
         AND checked_at > $4::timestamptz - make_interval(hours => $5)`,
      [this.organizationId, providerId, numbers, now, provider.maxAgeHours],
    );
    const known = new Set(fresh.rows.map((row) => row.phone_number));
    const stale = numbers.filter((number) => !known.has(number));
    if (!stale.length) return;
    for (const result of await provider.check(stale, { category }))
      await this.store(db, { ...result, checkedAt: now }, providerId);
  }

  async get(phoneNumber: string, provider = MANUAL_UPLOAD_PROVIDER) {
    const result = await this.pool.query(
      `SELECT phone_number, provider, result, blocked_categories, blocked_time_bands,
         blocked_day_types, checked_at, provider_ref
       FROM ovo_ops_preference_checks WHERE organization_id = $1 AND phone_number = $2 AND provider = $3`,
      [this.organizationId, normalizePhoneNumber(phoneNumber), provider],
    );
    return result.rows[0];
  }

  private async store(db: Database, row: PreferenceUploadRow, provider: string): Promise<void> {
    await db.query(
      `INSERT INTO ovo_ops_preference_checks (organization_id, phone_number, provider, result,
         blocked_categories, blocked_time_bands, blocked_day_types, checked_at, provider_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id, phone_number, provider) DO UPDATE SET result = EXCLUDED.result,
         blocked_categories = EXCLUDED.blocked_categories,
         blocked_time_bands = EXCLUDED.blocked_time_bands,
         blocked_day_types = EXCLUDED.blocked_day_types, checked_at = EXCLUDED.checked_at,
         provider_ref = EXCLUDED.provider_ref
       WHERE ovo_ops_preference_checks.checked_at <= EXCLUDED.checked_at`,
      [
        this.organizationId,
        row.phoneNumber,
        provider,
        row.result,
        row.blockedCategories ?? null,
        row.blockedTimeBands ?? null,
        row.blockedDayTypes ?? null,
        row.checkedAt ?? new Date(),
        row.ref ?? null,
      ],
    );
  }
}
