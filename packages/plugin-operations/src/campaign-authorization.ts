import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CampaignRow, ContactRow } from './campaign-model.ts';
import { admissionJobId, recordAuthorizedAttempt } from './compliance/ledger.ts';
import { SUPPRESSION_APPLIES } from './compliance/suppression-sql.ts';
import type { DialAuthorization } from './types.ts';

/**
 * Before each admission: expired leases go back in the queue, and queued contacts that are now on
 * the do-not-call list or out of attempts end.
 */
export async function reclassifyContacts(
  client: PoolClient,
  campaign: CampaignRow,
  organizationId: string,
): Promise<void> {
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
    `WITH blocked AS (SELECT c.id FROM ovo_ops_campaign_contacts c
       JOIN ovo_ops_campaigns k ON k.id = c.campaign_id
       JOIN ovo_ops_suppressions s ON s.organization_id = $2 AND s.phone_number = c.phone_number
       WHERE c.campaign_id = $1 AND c.state = 'queued' AND ${SUPPRESSION_APPLIES}
       ORDER BY c.id FOR UPDATE OF c SKIP LOCKED LIMIT 100)
     UPDATE ovo_ops_campaign_contacts c SET state = 'suppressed', updated_at = now()
     FROM blocked WHERE c.id = blocked.id`,
    [campaign.id, organizationId],
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

/** Writes the attempt, the contact's dialing state and the recipient-ledger row together. */
export async function persistAuthorization(
  client: PoolClient,
  organizationId: string,
  campaign: CampaignRow,
  contact: ContactRow,
  sequence: number,
): Promise<DialAuthorization> {
  const attemptId = randomUUID();
  const requestId = `${campaign.id}:${contact.id}:${contact.owner_epoch}`;
  const authorization = authorizationFrom(attemptId, requestId, campaign, contact);
  await client.query(
    `INSERT INTO ovo_ops_attempts (id, campaign_id, contact_id, request_id, sequence, status)
     VALUES ($1,$2,$3,$4,$5,'authorized')`,
    [attemptId, campaign.id, contact.id, requestId, sequence],
  );
  await client.query(
    `UPDATE ovo_ops_campaign_contacts SET state = 'dialing', compliance_reason = NULL,
       updated_at = now() WHERE id = $1`,
    [contact.id],
  );
  await recordAuthorizedAttempt(client, organizationId, {
    attemptId,
    campaign,
    contact,
    callId: await admissionJobId(client, campaign.id, contact),
  });
  return authorization;
}

export function authorizationFrom(
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
