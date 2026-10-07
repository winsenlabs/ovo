import type { PoolClient } from 'pg';
import { callingWindowState } from './calling-window.ts';
import type { CampaignRow, ContactRow } from './campaign-model.ts';
import type { ContactAdmission } from './types.ts';
import type { ComplianceGate, GateResult } from './compliance/gate.ts';
import { refusalEffect, SUPPRESSION_APPLIES } from './compliance/suppression-sql.ts';
import { validateReleaseVariables } from './release-variables.ts';

/** Invalid contacts one admission marks before it gives up until the next tick. */
const MAX_INVALID_SKIPS = 100;
/** Contacts one admission may defer or end on compliance grounds before it waits a tick. */
const MAX_GATED_SKIPS = 50;

/**
 * The next dialable contact. One whose variables fail the release schema snapshotted at create is
 * marked `invalid` and skipped: it could only reach the agent with fields its lines cannot fill.
 */
export async function nextValidContact(
  client: PoolClient,
  campaign: CampaignRow,
  organizationId: string,
): Promise<ContactRow | undefined> {
  for (let skipped = 0; skipped <= MAX_INVALID_SKIPS; skipped += 1) {
    const selected = await client.query<ContactRow>(
      `SELECT c.* FROM ovo_ops_campaign_contacts c JOIN ovo_ops_campaigns k ON k.id = c.campaign_id
         WHERE c.campaign_id = $1 AND c.state = 'queued' AND c.not_before <= now()
           AND NOT EXISTS (SELECT 1 FROM ovo_ops_suppressions s
             WHERE s.organization_id = $2 AND s.phone_number = c.phone_number AND ${SUPPRESSION_APPLIES})
           AND (SELECT count(*) FROM ovo_ops_attempts a WHERE a.contact_id = c.id) < $3
         ORDER BY c.source_row, c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
      [campaign.id, organizationId, campaign.per_number_attempt_limit],
    );
    const contact = selected.rows[0];
    if (!contact || !campaign.variables_schema) return contact;
    if (validateReleaseVariables(campaign.variables_schema, contact.variables).valid)
      return contact;
    await client.query(
      `UPDATE ovo_ops_campaign_contacts SET state = 'invalid', updated_at = now() WHERE id = $1`,
      [contact.id],
    );
  }
  return undefined;
}

/**
 * A contact admitted inside the calling window but authorized after it closed goes back in the
 * queue until the window opens, instead of being dialed. True when it was requeued. A campaign
 * with a compliance policy is left to the gate, which judges the same window in the recipient's
 * timezone (IST for +91) and would disagree with this schedule-timezone reading.
 */
export async function requeueOutsideWindow(
  client: PoolClient,
  campaign: CampaignRow,
  contactId: string,
): Promise<boolean> {
  if (campaign.compliance_policy) return false;
  const window = campaign.calling_window ? callingWindowState(campaign.calling_window) : undefined;
  if (!window || window.open) return false;
  await requeueContact(client, contactId, window.nextOpenAt, 'outside_calling_hours');
  return true;
}

async function requeueContact(
  client: PoolClient,
  contactId: string,
  notBefore: Date,
  reason: string | null,
): Promise<void> {
  await client.query(
    `UPDATE ovo_ops_campaign_contacts SET state = 'queued', owner_id = NULL,
     admission_campaign_version = NULL, lease_expires_at = NULL, not_before = $2,
     compliance_reason = $3, updated_at = now() WHERE id = $1`,
    [contactId, notBefore, reason],
  );
}

/**
 * Applies a refused or deferred compliance verdict: a deferred contact waits in the queue until it
 * is eligible, a refused one ends as `suppressed` or `invalid`, and a refusal about the sender
 * pauses the campaign (the contact waits for it to resume).
 */
export async function applyGateVerdict(
  client: PoolClient,
  campaign: CampaignRow,
  contactId: string,
  verdict: GateResult,
): Promise<'deferred' | 'ended' | 'paused'> {
  const reason = verdict.reason ?? null;
  if (verdict.verdict === 'defer') {
    await requeueContact(client, contactId, verdict.nextEligibleAt ?? new Date(), reason);
    return 'deferred';
  }
  const effect = refusalEffect(verdict.reason ?? '');
  if (effect === 'pause') {
    await requeueContact(client, contactId, new Date(), reason);
    await client.query(
      `UPDATE ovo_ops_campaigns SET status = 'paused', version = version + 1,
         driver_error = $2, updated_at = now() WHERE id = $1 AND status IN ('running','scheduled')`,
      [campaign.id, `compliance:${reason}`],
    );
    return 'paused';
  }
  await client.query(
    `UPDATE ovo_ops_campaign_contacts SET state = $2, owner_id = NULL,
       admission_campaign_version = NULL, lease_expires_at = NULL, compliance_reason = $3,
       updated_at = now() WHERE id = $1`,
    [contactId, effect, reason],
  );
  return 'ended';
}

/**
 * The next contact the compliance gate allows (stage E3). A campaign created before the gate has
 * no policy and is admitted as before; a deferred contact waits for its eligible time, and when
 * every candidate waits for the window the campaign reports when it next opens.
 */
export async function nextCompliantContact(
  client: PoolClient,
  campaign: CampaignRow,
  organizationId: string,
  gate: ComplianceGate,
): Promise<
  { kind: 'contact'; contact: ContactRow } | { kind: 'none'; admission: ContactAdmission }
> {
  let opensAt: Date | undefined;
  for (let skipped = 0; skipped < MAX_GATED_SKIPS; skipped += 1) {
    const contact = await nextValidContact(client, campaign, organizationId);
    if (!contact) break;
    if (!campaign.compliance_policy) return { kind: 'contact', contact };
    const verdict = await gate.check(client, {
      stage: 'admit',
      phoneNumber: contact.phone_number,
      fromNumber: campaign.from_number,
      policy: campaign.compliance_policy,
      campaignId: campaign.id,
      contactId: contact.id,
      skipWindow: campaign.compliance_policy.manual,
    });
    if (verdict.verdict === 'allow') return { kind: 'contact', contact };
    const effect = await applyGateVerdict(client, campaign, contact.id, verdict);
    if (effect === 'paused')
      return { kind: 'none', admission: { kind: 'compliance_paused', reason: verdict.reason! } };
    if (verdict.reason === 'outside_calling_hours' && verdict.nextEligibleAt)
      opensAt =
        opensAt && opensAt.getTime() < verdict.nextEligibleAt.getTime()
          ? opensAt
          : verdict.nextEligibleAt;
  }
  return {
    kind: 'none',
    admission: opensAt ? { kind: 'outside_calling_hours', nextOpenAt: opensAt } : { kind: 'empty' },
  };
}
