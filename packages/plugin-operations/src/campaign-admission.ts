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
import { transaction } from './database.ts';
import type {
  CampaignDialJob,
  ContactAdmission,
  DialAuthorization,
  DialAuthorizationResult,
} from './types.ts';

export class CampaignAdmissionService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async admit(
    campaignId: string,
    ownerId: string,
    leaseMs: number,
    requestedJobId?: string,
  ): Promise<ContactAdmission> {
    positiveInteger(leaseMs, 'leaseMs', 300_000);
    return transaction(this.pool, async (client) => {
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
      const quota = await campaignQuotaState(client, campaign);
      if (quota) return { kind: 'quota_exhausted', quota };
      const selected = await client.query<ContactRow>(
        `SELECT c.* FROM ovo_ops_campaign_contacts c
         WHERE c.campaign_id = $1 AND c.state = 'queued' AND c.not_before <= now()
           AND NOT EXISTS (SELECT 1 FROM ovo_ops_suppressions s
             WHERE s.organization_id = $2 AND s.phone_number = c.phone_number)
           AND (SELECT count(*) FROM ovo_ops_attempts a WHERE a.contact_id = c.id) < $3
         ORDER BY c.source_row, c.id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [campaignId, this.organizationId, campaign.per_number_attempt_limit],
      );
      const contact = selected.rows[0];
      if (!contact) return { kind: 'empty' };
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
    });
  }

  private async reclassifyContacts(client: PoolClient, campaign: CampaignRow): Promise<void> {
    await client.query(
      `WITH expired AS (SELECT id FROM ovo_ops_campaign_contacts
         WHERE campaign_id = $1 AND state = 'admitted'
           AND (lease_expires_at <= now() OR admission_campaign_version <> $2)
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100)
       UPDATE ovo_ops_campaign_contacts c SET state = 'queued', owner_id = NULL,
         admission_campaign_version = NULL, lease_expires_at = NULL, updated_at = now()
       FROM expired WHERE c.id = expired.id`,
      [campaign.id, campaign.version],
    );
    await client.query(
      `WITH blocked AS (SELECT c.id FROM ovo_ops_campaign_contacts c JOIN ovo_ops_suppressions s
         ON s.organization_id = $2 AND s.phone_number = c.phone_number
         WHERE c.campaign_id = $1 AND c.state = 'queued' ORDER BY c.id FOR UPDATE OF c SKIP LOCKED LIMIT 100)
       UPDATE ovo_ops_campaign_contacts c SET state = 'suppressed', updated_at = now()
       FROM blocked WHERE c.id = blocked.id`,
      [campaign.id, this.organizationId],
    );
    await client.query(
      `WITH exhausted AS (SELECT c.id FROM ovo_ops_campaign_contacts c
         WHERE c.campaign_id = $1 AND c.state = 'queued'
           AND (SELECT count(*) FROM ovo_ops_attempts a WHERE a.contact_id = c.id) >= $2
         ORDER BY c.id FOR UPDATE OF c SKIP LOCKED LIMIT 100)
       UPDATE ovo_ops_campaign_contacts c SET state = 'exhausted', updated_at = now()
       FROM exhausted WHERE c.id = exhausted.id`,
      [campaign.id, campaign.per_number_attempt_limit],
    );
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
        'SELECT 1 FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2',
        [this.organizationId, current.phone_number],
      );
      if (suppressed.rowCount) {
        await client.query(
          `UPDATE ovo_ops_campaign_contacts SET state = 'suppressed', owner_id = NULL,
           admission_campaign_version = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
          [contactId],
        );
        return { kind: 'blocked', reason: 'suppressed' };
      }
      const requestId = `${campaign.id}:${contactId}:${ownerEpoch}`;
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM ovo_ops_attempts WHERE request_id = $1',
        [requestId],
      );
      if (existing.rows[0] && current.state === 'dialing')
        return this.authorizationFrom(existing.rows[0].id, requestId, campaign, current);
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
      return this.persistAuthorization(
        client,
        campaign,
        current,
        Number(attempts.rows[0]!.count) + 1,
      );
    });
  }

  private async persistAuthorization(
    client: PoolClient,
    campaign: CampaignRow,
    contact: ContactRow,
    sequence: number,
  ): Promise<DialAuthorization> {
    const attemptId = randomUUID();
    const requestId = `${campaign.id}:${contact.id}:${contact.owner_epoch}`;
    const authorization: DialAuthorization = {
      kind: 'authorized',
      attemptId,
      requestId,
      campaignId: campaign.id,
      contactId: contact.id,
      to: contact.phone_number,
      from: campaign.from_number,
      agentReleaseId: campaign.agent_release_id,
      variables: contact.variables,
    };
    await client.query(
      `INSERT INTO ovo_ops_attempts (id, campaign_id, contact_id, request_id, sequence, status)
       VALUES ($1,$2,$3,$4,$5,'authorized')`,
      [attemptId, campaign.id, contact.id, requestId, sequence],
    );
    await client.query(
      `UPDATE ovo_ops_campaign_contacts SET state = 'dialing', updated_at = now() WHERE id = $1`,
      [contact.id],
    );
    return authorization;
  }

  private authorizationFrom(
    attemptId: string,
    requestId: string,
    campaign: CampaignRow,
    contact: ContactRow,
  ): DialAuthorization {
    return {
      kind: 'authorized',
      attemptId,
      requestId,
      campaignId: campaign.id,
      contactId: contact.id,
      to: contact.phone_number,
      from: campaign.from_number,
      agentReleaseId: campaign.agent_release_id,
      variables: contact.variables,
    };
  }
}
