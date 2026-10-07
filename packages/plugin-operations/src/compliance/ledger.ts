import type { PoolClient } from 'pg';
import type { WorkspaceCompliance } from '@winsendotai/ovo-contracts';
import type { CampaignRow, ContactRow } from '../campaign-model.ts';
import type { CompliancePolicy } from './policy.ts';
import { attemptOutcome, retryAfter } from './retry-policy.ts';

/** The per-recipient contact ledger (G9): one row per authorized attempt, org-wide. */
export async function recordAuthorizedAttempt(
  client: PoolClient,
  organizationId: string,
  input: { attemptId: string; campaign: CampaignRow; contact: ContactRow; callId?: string },
): Promise<void> {
  const policy = input.campaign.compliance_policy as CompliancePolicy | null;
  await client.query(
    `INSERT INTO ovo_ops_recipient_attempts (organization_id, attempt_id, phone_number, from_number,
       category, purpose, campaign_id, contact_id, call_id, authorized_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT DO NOTHING`,
    [
      organizationId,
      input.attemptId,
      input.contact.phone_number,
      input.campaign.from_number,
      policy?.category ?? null,
      policy?.purpose ?? null,
      input.campaign.id,
      input.contact.id,
      input.callId ?? null,
    ],
  );
}

/** The outbox job id a contact's current admission was queued under: the call id downstream. */
export async function admissionJobId(
  client: PoolClient,
  campaignId: string,
  contact: ContactRow,
): Promise<string | undefined> {
  const result = await client.query<{ aggregate_id: string }>(
    `SELECT aggregate_id::text AS aggregate_id FROM ovo_ops_outbox
     WHERE topic = 'campaign.dial.candidate' AND dedup_key = $1`,
    [`${campaignId}:${contact.id}:${contact.owner_epoch}`],
  );
  return result.rows[0]?.aggregate_id;
}

/**
 * Folds an attempt event into the ledger: answered, then ended with its outcome. A failed attempt
 * of a campaign with a compliance policy is requeued per the retry policy; the answer says when.
 */
export async function recordLedgerEvent(
  client: PoolClient,
  organizationId: string,
  input: {
    attemptId: string;
    status: string;
    reason?: string;
    occurredAt: Date;
    contactId: string;
    settings: WorkspaceCompliance | undefined;
    attemptLimit: number;
  },
): Promise<{ retryAt?: Date }> {
  if (input.status === 'connected') {
    await client.query(
      `UPDATE ovo_ops_recipient_attempts SET connected_at = COALESCE(connected_at, $3)
       WHERE organization_id = $1 AND attempt_id = $2`,
      [organizationId, input.attemptId, input.occurredAt],
    );
    return {};
  }
  if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(input.status)) return {};
  const outcome = attemptOutcome(input.status, input.reason);
  const updated = await client.query<{ phone_number: string }>(
    `UPDATE ovo_ops_recipient_attempts SET ended_at = $3, terminal_status = $4, outcome = $5
     WHERE organization_id = $1 AND attempt_id = $2 RETURNING phone_number`,
    [organizationId, input.attemptId, input.occurredAt, input.status, outcome],
  );
  if (!updated.rowCount || input.status !== 'failed' || !input.settings) return {};
  const history = await client.query<{ total: string; same: string }>(
    `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE outcome = $3 AND attempt_id <> $4)::text AS same
     FROM ovo_ops_recipient_attempts WHERE organization_id = $1 AND contact_id = $2`,
    [organizationId, input.contactId, outcome, input.attemptId],
  );
  if (Number(history.rows[0]!.total) >= input.attemptLimit) return {};
  const retryAt = retryAfter(outcome, Number(history.rows[0]!.same), input.settings, new Date());
  return retryAt ? { retryAt } : {};
}
