import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { InboundGatewayDecision } from './types.ts';

export interface CallbackAdmissionRow extends QueryResultRow {
  id: string;
  call_id: string;
  decision: string;
  detail: Record<string, unknown>;
  from_number: string | null;
  to_number: string | null;
  release_id: string | null;
  variables: Record<string, string> | null;
  callback_campaign_id: string | null;
  callback_contact_id: string | null;
  callback_job_id: string | null;
}

function callbackDecision(row: CallbackAdmissionRow): InboundGatewayDecision {
  const state = String(row.detail.state ?? 'prompt');
  if (state === 'queued') {
    if (!row.callback_campaign_id || !row.callback_contact_id || !row.callback_job_id)
      throw new Error('Persisted callback request is incomplete');
    return {
      kind: 'callback',
      admissionId: row.id,
      state: 'queued',
      announcement: String(row.detail.announcement ?? ''),
      campaignId: row.callback_campaign_id,
      contactId: row.callback_contact_id,
      jobId: row.callback_job_id,
    };
  }
  return {
    kind: 'callback',
    admissionId: row.id,
    state: state === 'declined' || state === 'suppressed' ? state : 'prompt',
    announcement: String(row.detail.announcement ?? ''),
  };
}

export async function confirmInboundCallback(
  client: PoolClient,
  organizationId: string,
  row: CallbackAdmissionRow,
  digits: string,
): Promise<InboundGatewayDecision> {
  if (row.decision !== 'callback') throw new Error('Inbound call is not awaiting callback consent');
  const current = callbackDecision(row);
  if (current.kind === 'callback' && current.state !== 'prompt') return current;
  if (digits !== '1') {
    const detail = { ...row.detail, state: 'declined' };
    await client.query('UPDATE ovo_ops_inbound_admissions SET detail = $2::jsonb WHERE id = $1', [
      row.id,
      JSON.stringify(detail),
    ]);
    return { kind: 'callback', admissionId: row.id, state: 'declined', announcement: '' };
  }
  if (!row.from_number || !row.to_number || !row.release_id || !row.variables)
    throw new Error('Callback admission snapshot is incomplete');

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `ovo-ops-suppression:${organizationId}:${row.from_number}`,
  ]);
  const suppressed = await client.query(
    'SELECT 1 FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2',
    [organizationId, row.from_number],
  );
  const campaignId = randomUUID();
  const contactId = randomUUID();
  const operationId = `inbound-callback:${row.call_id}`;
  const digest = createHash('sha256')
    .update(JSON.stringify({ operationId, releaseId: row.release_id, variables: row.variables }))
    .digest('hex');
  const queue = String(row.detail.queue ?? 'callback');
  await client.query(
    `INSERT INTO ovo_ops_campaigns
       (id, organization_id, operation_id, input_digest, name, agent_release_id, from_number,
        status, schedule_at, timezone, per_number_attempt_limit, max_attempts_total,
        max_attempts_per_local_day, active_call_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running',now(),'UTC',1,1,1,'continue')`,
    [
      campaignId,
      organizationId,
      operationId,
      digest,
      `Inbound callback: ${queue}`.slice(0, 200),
      row.release_id,
      row.to_number,
    ],
  );
  const state = suppressed.rowCount ? 'suppressed' : 'admitted';
  await client.query(
    `INSERT INTO ovo_ops_campaign_contacts
       (id, campaign_id, source_row, phone_number, external_id, variables, state, owner_id,
        owner_epoch, admission_campaign_version, lease_expires_at)
     VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7,$8,$9,
       CASE WHEN $6 = 'admitted' THEN now() + interval '5 minutes' ELSE NULL END)`,
    [
      contactId,
      campaignId,
      row.from_number,
      row.call_id,
      JSON.stringify(row.variables),
      state,
      suppressed.rowCount ? null : 'inbound-callback',
      suppressed.rowCount ? 0 : 1,
      suppressed.rowCount ? null : 1,
    ],
  );
  if (suppressed.rowCount) {
    const detail = { ...row.detail, state: 'suppressed' };
    await client.query(
      `UPDATE ovo_ops_inbound_admissions SET detail = $2::jsonb,
         callback_campaign_id = $3, callback_contact_id = $4 WHERE id = $1`,
      [row.id, JSON.stringify(detail), campaignId, contactId],
    );
    return {
      kind: 'callback',
      admissionId: row.id,
      state: 'suppressed',
      announcement: '',
    };
  }

  const jobId = randomUUID();
  const payload = {
    kind: 'campaign_dial_candidate',
    jobId,
    campaignId,
    contactId,
    admissionOwnerId: 'inbound-callback',
    admissionEpoch: 1,
  };
  await client.query(
    `INSERT INTO ovo_ops_outbox (id, topic, aggregate_id, dedup_key, payload)
     VALUES ($1,'campaign.dial.candidate',$2,$3,$4::jsonb)`,
    [randomUUID(), jobId, `${campaignId}:${contactId}:1`, JSON.stringify(payload)],
  );
  const detail = { ...row.detail, state: 'queued' };
  await client.query(
    `UPDATE ovo_ops_inbound_admissions SET detail = $2::jsonb,
       callback_campaign_id = $3, callback_contact_id = $4, callback_job_id = $5 WHERE id = $1`,
    [row.id, JSON.stringify(detail), campaignId, contactId, jobId],
  );
  return {
    kind: 'callback',
    admissionId: row.id,
    state: 'queued',
    announcement: String(row.detail.announcement ?? ''),
    campaignId,
    contactId,
    jobId,
  };
}
