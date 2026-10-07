import type {
  ConsentBasis,
  PreferenceResult,
  SuppressionScope,
  SuppressionSource,
  WorkspaceCompliance,
} from '@winsendotai/ovo-contracts';
import type { Database } from '../types.ts';
import type { RecipientFacts } from './evaluate.ts';
import { breakerState } from './ratios.ts';
import type { CliSeries } from './rule-packs.ts';

/** Everything the evaluator needs about one recipient and one caller number, read in one place. */
export async function loadRecipientFacts(
  db: Database,
  organizationId: string,
  input: {
    phoneNumber: string;
    fromNumber: string;
    settings: WorkspaceCompliance;
    provider: string;
    now: Date;
  },
): Promise<RecipientFacts> {
  const { phoneNumber, fromNumber, settings, now } = input;
  const [suppression, complaint, consents, preference, ledger, cli, a2p] = await Promise.all([
    db.query<{ source: SuppressionSource; scope: SuppressionScope; purpose: string | null }>(
      'SELECT source, scope, purpose FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2',
      [organizationId, phoneNumber],
    ),
    db.query(
      `SELECT 1 FROM ovo_ops_complaints WHERE organization_id = $1 AND phone_number = $2
         AND status IN ('open','acknowledged','represented') LIMIT 1`,
      [organizationId, phoneNumber],
    ),
    db.query<{
      id: string;
      basis: ConsentBasis;
      category: string;
      principal_entity: string;
      purpose: string;
      obtained_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, basis, category, principal_entity, purpose, obtained_at, expires_at, revoked_at
       FROM ovo_ops_consents WHERE organization_id = $1 AND phone_number = $2
       ORDER BY obtained_at DESC LIMIT 200`,
      [organizationId, phoneNumber],
    ),
    db.query<{ result: PreferenceResult; checked_at: Date; provider_ref: string | null }>(
      `SELECT result, checked_at, provider_ref FROM ovo_ops_preference_checks
       WHERE organization_id = $1 AND phone_number = $2 AND provider = $3`,
      [organizationId, phoneNumber, input.provider],
    ),
    db.query<{
      authorized_at: Date;
      connected: boolean;
      outcome: string | null;
      category: string | null;
    }>(
      `SELECT authorized_at, connected_at IS NOT NULL AS connected, outcome, category
       FROM ovo_ops_recipient_attempts WHERE organization_id = $1 AND phone_number = $2
         AND authorized_at > $3::timestamptz - interval '30 days'
       ORDER BY authorized_at DESC LIMIT 500`,
      [organizationId, phoneNumber, now],
    ),
    db.query<{ series: CliSeries; categories: string[]; status: string }>(
      `SELECT series, categories, status FROM ovo_ops_cli_numbers
       WHERE organization_id = $1 AND phone_number = $2`,
      [organizationId, fromNumber],
    ),
    db.query(
      `SELECT 1 FROM ovo_ops_a2p_declarations WHERE organization_id = $1 AND withdrawn_at IS NULL
         AND effective_from <= ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
         AND length(range_start) = length($2) AND $2 BETWEEN range_start AND range_end LIMIT 1`,
      [organizationId, fromNumber, now],
    ),
  ]);
  const row = suppression.rows[0];
  const checked = preference.rows[0];
  return {
    ...(row
      ? {
          suppression: {
            source: row.source,
            scope: row.scope,
            ...(row.purpose ? { purpose: row.purpose } : {}),
          },
        }
      : {}),
    openComplaint: !!complaint.rowCount,
    consents: consents.rows.map((consent) => ({
      id: consent.id,
      basis: consent.basis,
      category: consent.category,
      principalEntity: consent.principal_entity,
      purpose: consent.purpose,
      obtainedAt: consent.obtained_at,
      ...(consent.expires_at ? { expiresAt: consent.expires_at } : {}),
      ...(consent.revoked_at ? { revokedAt: consent.revoked_at } : {}),
    })),
    ...(checked
      ? {
          preference: {
            result: checked.result,
            checkedAt: checked.checked_at,
            provider: input.provider,
            ...(checked.provider_ref ? { ref: checked.provider_ref } : {}),
          },
        }
      : {}),
    ledger: ledger.rows.map((attempt) => ({
      authorizedAt: attempt.authorized_at,
      connected: attempt.connected,
      ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
      ...(attempt.category ? { category: attempt.category } : {}),
    })),
    ...(cli.rows[0] ? { cli: cli.rows[0] } : {}),
    a2pDeclared: !!a2p.rowCount,
    ...(await cliVelocity(db, organizationId, fromNumber, cli.rows[0]?.series, settings, now)),
    breakerTripped:
      settings.enforcement.abandonedBreaker === 'enforce' &&
      (await breakerState(db, organizationId, fromNumber, settings, now)).tripped,
  };
}

/**
 * When a CLI outside 140/1600/1601 next has room under its hourly and daily limits (R20): the
 * telco's AI flags such numbers on volume and velocity, and designated series are never flagged.
 */
async function cliVelocity(
  db: Database,
  organizationId: string,
  fromNumber: string,
  series: CliSeries | undefined,
  settings: WorkspaceCompliance,
  now: Date,
): Promise<{ cliBlockedUntil?: Date }> {
  if (series && series !== 'other') return {};
  let blockedUntil: Date | undefined;
  for (const [limit, hours] of [
    [settings.pacing.otherSeriesPerHour, 1],
    [settings.pacing.otherSeriesPerDay, 24],
  ] as const) {
    if (!limit) continue;
    const result = await db.query<{ authorized_at: Date }>(
      `SELECT authorized_at FROM ovo_ops_recipient_attempts
       WHERE organization_id = $1 AND from_number = $2
         AND authorized_at > $3::timestamptz - make_interval(hours => $4)
       ORDER BY authorized_at DESC OFFSET $5 LIMIT 1`,
      [organizationId, fromNumber, now, hours, limit - 1],
    );
    const oldest = result.rows[0];
    if (!oldest) continue;
    const until = new Date(oldest.authorized_at.getTime() + hours * 3_600_000);
    if (!blockedUntil || until.getTime() > blockedUntil.getTime()) blockedUntil = until;
  }
  return blockedUntil ? { cliBlockedUntil: blockedUntil } : {};
}
