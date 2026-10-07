import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  campaignColumns,
  campaignQuotaState,
  lockedCampaign,
  positiveInteger,
  type CampaignRow,
  type ContactRow,
} from './campaign-model.ts';
import { callingWindowState } from './calling-window.ts';
import { transaction } from './database.ts';
import {
  applyGateVerdict,
  nextCompliantContact,
  requeueOutsideWindow,
} from './campaign-admission-checks.ts';
import { ComplianceGate } from './compliance/gate.ts';
import {
  authorizationFrom,
  persistAuthorization,
  reclassifyContacts,
} from './campaign-authorization.ts';
import { ComplianceSettingsStore } from './compliance/settings.ts';
import { SUPPRESSION_APPLIES } from './compliance/suppression-sql.ts';
import type { CampaignDialJob, ContactAdmission, DialAuthorizationResult } from './types.ts';

export class CampaignAdmissionService {
  private readonly gate: ComplianceGate;

  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    gate?: ComplianceGate,
  ) {
    this.gate =
      gate ?? new ComplianceGate(organizationId, new ComplianceSettingsStore(pool, organizationId));
  }

  async admit(
    campaignId: string,
    ownerId: string,
    leaseMs: number,
    requestedJobId?: string,
  ): Promise<ContactAdmission> {
    positiveInteger(leaseMs, 'leaseMs', 300_000);
    return transaction(this.pool, (client) =>
      this.admitWithClient(client, campaignId, ownerId, leaseMs, requestedJobId),
    );
  }

  async admitWithClient(
    client: PoolClient,
    campaignId: string,
    ownerId: string,
    leaseMs: number,
    requestedJobId?: string,
  ): Promise<ContactAdmission> {
    positiveInteger(leaseMs, 'leaseMs', 300_000);
    let campaign = await lockedCampaign(client, this.organizationId, campaignId);
    if (campaign.status === 'scheduled') {
      if (campaign.schedule_at.getTime() > Date.now())
        return { kind: 'scheduled', scheduleAt: campaign.schedule_at };
      const started = await client.query<CampaignRow>(
        `UPDATE ovo_ops_campaigns SET status = 'running', version = version + 1, updated_at = now()
           WHERE id = $1 RETURNING ${campaignColumns}`,
        [campaignId],
      );
      campaign = started.rows[0]!;
    }
    if (campaign.status !== 'running')
      return { kind: 'campaign_not_running', status: campaign.status };
    await this.reclassifyContacts(client, campaign);
    const capacity = await client.query<{ active: string }>(
      `SELECT count(*)::text AS active FROM ovo_ops_campaign_contacts
         WHERE campaign_id = $1 AND state IN ('admitted','dialing','active','unknown')`,
      [campaignId],
    );
    if (Number(capacity.rows[0]!.active) >= campaign.max_concurrency)
      return { kind: 'capacity_exhausted' };
    const quota = await campaignQuotaState(client, campaign);
    if (quota) return { kind: 'quota_exhausted', quota };
    // With a compliance policy the gate judges the campaign window (in IST for +91 numbers), so
    // reading it again here in the schedule timezone would only close it where the two disagree.
    const window =
      campaign.calling_window && !campaign.compliance_policy
        ? callingWindowState(campaign.calling_window)
        : undefined;
    if (window && !window.open)
      return { kind: 'outside_calling_hours', nextOpenAt: window.nextOpenAt };
    const gated = await nextCompliantContact(client, campaign, this.organizationId, this.gate);
    if (gated.kind !== 'contact') return gated.admission;
    const contact = gated.contact;
    const claimed = await client.query<ContactRow>(
      `UPDATE ovo_ops_campaign_contacts SET state = 'admitted', owner_id = $2,
           owner_epoch = owner_epoch + 1, admission_campaign_version = $4,
           lease_expires_at = now() + $3 * interval '1 millisecond', updated_at = now()
         WHERE id = $1 RETURNING *`,
      [contact.id, ownerId, leaseMs, campaign.version],
    );
    const row = claimed.rows[0]!;
    const jobId = requestedJobId ?? randomUUID();
    const job: CampaignDialJob = {
      kind: 'campaign_dial_candidate',
      jobId,
      campaignId,
      contactId: row.id,
      admissionOwnerId: ownerId,
      admissionEpoch: Number(row.owner_epoch),
    };
    await client.query(
      `INSERT INTO ovo_ops_outbox (id, topic, aggregate_id, dedup_key, payload)
         VALUES ($1,'campaign.dial.candidate',$2,$3,$4::jsonb)`,
      [randomUUID(), jobId, `${campaignId}:${row.id}:${row.owner_epoch}`, JSON.stringify(job)],
    );
    return {
      kind: 'admitted',
      jobId,
      contactId: row.id,
      ownerEpoch: Number(row.owner_epoch),
      leaseExpiresAt: row.lease_expires_at!,
    };
  }

  reclassifyContacts(client: PoolClient, campaign: CampaignRow): Promise<void> {
    return reclassifyContacts(client, campaign, this.organizationId);
  }

  async authorizeDial(
    contactId: string,
    ownerId: string,
    ownerEpoch: number,
  ): Promise<DialAuthorizationResult> {
    return transaction(this.pool, async (client) => {
      const contactResult = await client.query<ContactRow>(
        `SELECT c.* FROM ovo_ops_campaign_contacts c JOIN ovo_ops_campaigns k ON k.id = c.campaign_id
         WHERE c.id = $1 AND k.organization_id = $2`,
        [contactId, this.organizationId],
      );
      const contact = contactResult.rows[0];
      if (!contact) throw new Error('Campaign contact not found');
      const campaign = await lockedCampaign(client, this.organizationId, contact.campaign_id);
      const lockedContact = await client.query<ContactRow>(
        'SELECT * FROM ovo_ops_campaign_contacts WHERE id = $1 FOR UPDATE',
        [contactId],
      );
      const current = lockedContact.rows[0]!;
      if (campaign.status !== 'running') return { kind: 'blocked', reason: 'campaign_not_running' };
      if (
        !['admitted', 'dialing'].includes(current.state) ||
        current.owner_id !== ownerId ||
        Number(current.owner_epoch) !== ownerEpoch ||
        Number(current.admission_campaign_version) !== Number(campaign.version) ||
        !current.lease_expires_at ||
        current.lease_expires_at.getTime() <= Date.now()
      )
        return { kind: 'blocked', reason: 'lease_lost' };
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-ops-suppression:${this.organizationId}:${current.phone_number}`,
      ]);
      const suppressed = await client.query(
        `SELECT 1 FROM ovo_ops_suppressions s JOIN ovo_ops_campaigns k ON k.id = $3
         WHERE s.organization_id = $1 AND s.phone_number = $2 AND ${SUPPRESSION_APPLIES}`,
        [this.organizationId, current.phone_number, campaign.id],
      );
      if (suppressed.rowCount) {
        await client.query(
          `UPDATE ovo_ops_campaign_contacts SET state = 'suppressed', owner_id = NULL,
           admission_campaign_version = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
          [contactId],
        );
        return { kind: 'blocked', reason: 'suppressed' };
      }
      if (current.state === 'admitted' && (await requeueOutsideWindow(client, campaign, contactId)))
        return { kind: 'blocked', reason: 'outside_calling_hours' };
      const requestId = `${campaign.id}:${contactId}:${ownerEpoch}`;
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM ovo_ops_attempts WHERE request_id = $1',
        [requestId],
      );
      if (existing.rows[0] && current.state === 'dialing')
        return authorizationFrom(existing.rows[0].id, requestId, campaign, current);
      if (current.state !== 'admitted') return { kind: 'blocked', reason: 'lease_lost' };
      const attempts = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ovo_ops_attempts WHERE contact_id = $1',
        [contactId],
      );
      if (Number(attempts.rows[0]!.count) >= campaign.per_number_attempt_limit)
        return { kind: 'blocked', reason: 'attempt_limit' };
      const quota = await campaignQuotaState(client, campaign);
      if (quota)
        return { kind: 'blocked', reason: quota === 'total' ? 'total_quota' : 'daily_quota' };
      // The final gate (stage E4): the full evaluator, under the per-number lock, in this transaction.
      const policy = campaign.compliance_policy;
      const verdict = policy
        ? await this.gate.check(client, {
            stage: 'authorize',
            phoneNumber: current.phone_number,
            fromNumber: campaign.from_number,
            policy,
            campaignId: campaign.id,
            contactId,
            skipWindow: policy.manual,
          })
        : undefined;
      if (verdict && verdict.verdict !== 'allow') {
        await applyGateVerdict(client, campaign, contactId, verdict);
        return { kind: 'blocked', reason: verdict.reason! };
      }
      const authorization = await persistAuthorization(
        client,
        this.organizationId,
        campaign,
        current,
        Number(attempts.rows[0]!.count) + 1,
      );
      if (verdict)
        await client.query(
          'UPDATE ovo_ops_compliance_decisions SET attempt_id = $2 WHERE id = $1',
          [verdict.decisionId, authorization.attemptId],
        );
      return authorization;
    });
  }
}
