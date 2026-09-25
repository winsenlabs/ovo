import type { PoolClient, QueryResultRow } from 'pg';
import { normalizePhoneNumber } from './csv.ts';
import { resolveScheduledInstant } from './timezone.ts';
import type { CampaignConfig, CampaignRecord, CampaignStatus, ContactState } from './types.ts';

export interface CampaignRow extends QueryResultRow {
  id: string;
  operation_id: string;
  input_digest: string;
  name: string;
  agent_release_id: string;
  from_number: string;
  status: CampaignStatus;
  schedule_at: Date;
  timezone: string;
  per_number_attempt_limit: number;
  max_attempts_total: number;
  max_attempts_per_local_day: number;
  active_call_policy: 'continue' | 'request_end';
  version: string;
}

export interface ContactRow extends QueryResultRow {
  id: string;
  campaign_id: string;
  phone_number: string;
  variables: Record<string, string>;
  state: ContactState;
  owner_id: string | null;
  owner_epoch: string;
  admission_campaign_version: string | null;
  lease_expires_at: Date | null;
}

export const campaignColumns = `id, operation_id, input_digest, name, agent_release_id, from_number, status, schedule_at, timezone,
  per_number_attempt_limit, max_attempts_total, max_attempts_per_local_day, active_call_policy, version`;

export function campaignFromRow(row: CampaignRow): CampaignRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    name: row.name,
    agentReleaseId: row.agent_release_id,
    fromNumber: row.from_number,
    status: row.status,
    scheduleAt: row.schedule_at,
    timezone: row.timezone,
    perNumberAttemptLimit: row.per_number_attempt_limit,
    maxAttemptsTotal: row.max_attempts_total,
    maxAttemptsPerLocalDay: row.max_attempts_per_local_day,
    activeCallPolicy: row.active_call_policy,
    version: Number(row.version),
  };
}

export function positiveInteger(value: number, name: string, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${name} is out of range`);
}

export function validateCampaignConfig(config: CampaignConfig): Date {
  if (!config.operationId.trim() || config.operationId.length > 200)
    throw new Error('Campaign operationId is invalid');
  if (!config.name.trim() || !config.agentReleaseId.trim())
    throw new Error('Campaign identity is required');
  normalizePhoneNumber(config.fromNumber);
  positiveInteger(config.perNumberAttemptLimit, 'perNumberAttemptLimit', 100);
  positiveInteger(config.maxAttemptsTotal, 'maxAttemptsTotal', 10_000_000);
  positiveInteger(config.maxAttemptsPerLocalDay, 'maxAttemptsPerLocalDay', 10_000_000);
  if (!['continue', 'request_end'].includes(config.activeCallPolicy))
    throw new Error('activeCallPolicy is invalid');
  return resolveScheduledInstant(config.schedule.localDateTime, config.schedule.timezone);
}

export async function lockedCampaign(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<CampaignRow> {
  const result = await client.query<CampaignRow>(
    `SELECT ${campaignColumns} FROM ovo_ops_campaigns
     WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, organizationId],
  );
  if (!result.rows[0]) throw new Error('Campaign not found');
  return result.rows[0];
}

export async function campaignQuotaState(
  client: PoolClient,
  campaign: CampaignRow,
): Promise<'total' | 'daily' | undefined> {
  const result = await client.query<{ total: string; daily: string }>(
    `SELECT count(*)::text AS total,
      count(*) FILTER (WHERE (a.created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)::text AS daily
     FROM ovo_ops_attempts a WHERE a.campaign_id = $1`,
    [campaign.id, campaign.timezone],
  );
  if (Number(result.rows[0]!.total) >= campaign.max_attempts_total) return 'total';
  if (Number(result.rows[0]!.daily) >= campaign.max_attempts_per_local_day) return 'daily';
}
