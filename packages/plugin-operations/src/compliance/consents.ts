import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ComplianceCategory, ConsentBasis } from '@winsendotai/ovo-contracts';
import { normalizePhoneNumber } from '../csv.ts';
import { transaction } from '../database.ts';
import { IN_TCCCPR_2026_10 } from './rule-packs.ts';

export interface ConsentInput {
  phoneNumber: string;
  principalEntity: string;
  purpose: string;
  category: ComplianceCategory;
  basis: ConsentBasis;
  /** DLT consent id, CRF reference or the sender's inquiry/application record id. */
  evidenceRef: string;
  obtainedAt: Date;
  /** The customer opted in on their own, which the 90-day re-consent bar does not stop (R13). */
  customerInitiated?: boolean;
}

export interface ConsentRecord extends ConsentInput {
  id: string;
  expiresAt?: Date;
  revokedAt?: Date;
  revocationSource?: string;
  revocationRef?: string;
  createdAt: Date;
}

export type RevocationSource = 'in_call_opt_out' | 'dlt' | 'manual' | 'complaint';

export class ConsentRejected extends Error {
  constructor(
    readonly code: 'opt_out_locked' | 'invalid_consent',
    message: string,
  ) {
    super(message);
  }
}

const MINUTE = 60_000;
const DAY = 1_440 * MINUTE;
const pack = IN_TCCCPR_2026_10;

/** How long each basis lasts: 7 days (R11, R12), 3 months (R12) or 30 minutes (transactional). */
export function consentExpiry(basis: ConsentBasis, obtainedAt: Date): Date | undefined {
  const at = obtainedAt.getTime();
  if (basis === 'explicit_service_7d') return new Date(at + pack.explicitServiceConsentDays * DAY);
  if (basis === 'inquiry_7d') return new Date(at + pack.inquiryRelationshipDays * DAY);
  if (basis === 'application_3m') return new Date(at + pack.applicationRelationshipDays * DAY);
  if (basis === 'transaction_30min') return new Date(at + pack.transactionWindowMinutes * MINUTE);
  return undefined;
}

interface ConsentRow {
  id: string;
  phone_number: string;
  principal_entity: string;
  purpose: string;
  category: ComplianceCategory;
  basis: ConsentBasis;
  evidence_ref: string;
  customer_initiated: boolean;
  obtained_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revocation_source: string | null;
  revocation_ref: string | null;
  created_at: Date;
}

function fromRow(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    principalEntity: row.principal_entity,
    purpose: row.purpose,
    category: row.category,
    basis: row.basis,
    evidenceRef: row.evidence_ref,
    customerInitiated: row.customer_initiated,
    obtainedAt: row.obtained_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.revocation_source ? { revocationSource: row.revocation_source } : {}),
    ...(row.revocation_ref ? { revocationRef: row.revocation_ref } : {}),
    createdAt: row.created_at,
  };
}

/** The consent ledger (G7): purpose- and brand-scoped consent, with expiry and revocation. */
export class ConsentService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async record(input: ConsentInput): Promise<ConsentRecord> {
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    if (!input.evidenceRef.trim())
      throw new ConsentRejected('invalid_consent', 'Consent needs an evidence reference');
    if (!Number.isFinite(input.obtainedAt.getTime()) || input.obtainedAt.getTime() > Date.now())
      throw new ConsentRejected('invalid_consent', 'Consent cannot be obtained in the future');
    return transaction(this.pool, async (client) => {
      await lockNumber(client, this.organizationId, phoneNumber);
      if (input.basis !== 'inferred_relationship' && !input.customerInitiated) {
        const locked = await client.query(
          `SELECT 1 FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2
             AND source = 'opt_out' AND lock_until > now()
           UNION ALL
           SELECT 1 FROM ovo_ops_consents WHERE organization_id = $1 AND phone_number = $2
             AND category = $3 AND revoked_at > now() - make_interval(days => $4)`,
          [this.organizationId, phoneNumber, input.category, pack.reconsentCooldownDays],
        );
        if (locked.rowCount)
          throw new ConsentRejected(
            'opt_out_locked',
            'Consent may be sought again only 90 days after an opt-out or revocation',
          );
      }
      const result = await client.query<ConsentRow>(
        `INSERT INTO ovo_ops_consents (id, organization_id, phone_number, principal_entity, purpose,
           category, basis, evidence_ref, customer_initiated, obtained_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          randomUUID(),
          this.organizationId,
          phoneNumber,
          input.principalEntity.trim(),
          input.purpose.trim(),
          input.category,
          input.basis,
          input.evidenceRef.trim(),
          input.customerInitiated === true,
          input.obtainedAt,
          consentExpiry(input.basis, input.obtainedAt) ?? null,
        ],
      );
      return fromRow(result.rows[0]!);
    });
  }

  async revoke(id: string, source: RevocationSource, ref?: string): Promise<ConsentRecord> {
    const result = await this.pool.query<ConsentRow>(
      `UPDATE ovo_ops_consents SET revoked_at = COALESCE(revoked_at, now()),
         revocation_source = COALESCE(revocation_source, $3), revocation_ref = COALESCE(revocation_ref, $4)
       WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [id, this.organizationId, source, ref ?? null],
    );
    if (!result.rows[0]) throw new Error('Consent not found');
    return fromRow(result.rows[0]);
  }

  async list(phoneNumber: string): Promise<ConsentRecord[]> {
    const result = await this.pool.query<ConsentRow>(
      `SELECT * FROM ovo_ops_consents WHERE organization_id = $1 AND phone_number = $2
       ORDER BY obtained_at DESC LIMIT 100`,
      [this.organizationId, normalizePhoneNumber(phoneNumber)],
    );
    return result.rows.map(fromRow);
  }
}

/** The same per-number advisory lock the do-not-call list and dial authorization take. */
export function lockNumber(client: PoolClient, organizationId: string, phoneNumber: string) {
  return client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `ovo-ops-suppression:${organizationId}:${phoneNumber}`,
  ]);
}

/** An opt-out revokes the number's consents: every category, or promotional only (Q8). */
export async function revokeForOptOut(
  client: PoolClient,
  organizationId: string,
  phoneNumber: string,
  scope: 'all' | 'promotional',
  ref?: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE ovo_ops_consents SET revoked_at = now(), revocation_source = 'in_call_opt_out',
       revocation_ref = $4
     WHERE organization_id = $1 AND phone_number = $2 AND revoked_at IS NULL
       AND ($3 = 'all' OR category = 'promotional')`,
    [organizationId, phoneNumber, scope, ref ?? null],
  );
  return result.rowCount ?? 0;
}
