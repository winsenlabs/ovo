import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  campaignColumns,
  campaignFromRow,
  lockedCampaign,
  type CampaignRow,
  validateCampaignConfig,
} from './campaign-model.ts';
import { normalizePhoneNumber } from './csv.ts';
import { boundedLimit, transaction } from './database.ts';
import { inputDigest } from './identity.ts';
import type {
  CampaignCommandResult,
  CampaignConfig,
  CampaignContactInput,
  CampaignRecord,
  CampaignStatus,
  SuppressionRecord,
} from './types.ts';

export class CampaignAdminService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async create(
    config: CampaignConfig,
    contacts: readonly CampaignContactInput[],
  ): Promise<CampaignRecord> {
    const scheduleAt = validateCampaignConfig(config);
    if (contacts.length < 1 || contacts.length > 100)
      throw new Error('Create accepts 1 to 100 contacts');
    const normalized = contacts.map((contact) => ({
      ...contact,
      phoneNumber: normalizePhoneNumber(contact.phoneNumber),
    }));
    if (new Set(normalized.map((contact) => contact.phoneNumber)).size !== normalized.length)
      throw new Error('Campaign contains duplicate phone numbers');
    const id = randomUUID();
    const digest = inputDigest({ config, contacts: normalized });
    return transaction(this.pool, async (client) => {
      const status: CampaignStatus = scheduleAt.getTime() <= Date.now() ? 'running' : 'scheduled';
      const inserted = await client.query<CampaignRow>(
        `INSERT INTO ovo_ops_campaigns (
          id, organization_id, operation_id, input_digest, name, agent_release_id, from_number, status, schedule_at, timezone,
          per_number_attempt_limit, max_attempts_total, max_attempts_per_local_day, active_call_policy
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (organization_id, operation_id) DO NOTHING RETURNING ${campaignColumns}`,
        [
          id,
          this.organizationId,
          config.operationId,
          digest,
          config.name.trim(),
          config.agentReleaseId,
          normalizePhoneNumber(config.fromNumber),
          status,
          scheduleAt,
          config.schedule.timezone,
          config.perNumberAttemptLimit,
          config.maxAttemptsTotal,
          config.maxAttemptsPerLocalDay,
          config.activeCallPolicy,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<CampaignRow>(
          `SELECT ${campaignColumns} FROM ovo_ops_campaigns
           WHERE organization_id = $1 AND operation_id = $2`,
          [this.organizationId, config.operationId],
        );
        if (!existing.rows[0] || existing.rows[0].input_digest !== digest)
          throw new Error('Campaign operationId collision');
        return campaignFromRow(existing.rows[0]);
      }
      await this.insertContacts(client, id, normalized);
      return campaignFromRow(inserted.rows[0]!);
    });
  }

  async addContacts(
    campaignId: string,
    contacts: readonly CampaignContactInput[],
  ): Promise<number> {
    if (contacts.length < 1 || contacts.length > 100)
      throw new Error('Batch must contain 1 to 100 contacts');
    return transaction(this.pool, async (client) => {
      const campaign = await lockedCampaign(client, this.organizationId, campaignId);
      if (campaign.status === 'cancelled' || campaign.status === 'completed')
        throw new Error('Campaign no longer accepts contacts');
      return this.insertContacts(
        client,
        campaignId,
        contacts.map((contact) => ({
          ...contact,
          phoneNumber: normalizePhoneNumber(contact.phoneNumber),
        })),
      );
    });
  }

  async get(id: string): Promise<CampaignRecord> {
    const result = await this.pool.query<CampaignRow>(
      `SELECT ${campaignColumns} FROM ovo_ops_campaigns WHERE id = $1 AND organization_id = $2`,
      [id, this.organizationId],
    );
    if (!result.rows[0]) throw new Error('Campaign not found');
    return campaignFromRow(result.rows[0]);
  }

  async list(limit = 25, afterId?: string): Promise<CampaignRecord[]> {
    const result = await this.pool.query<CampaignRow>(
      `SELECT ${campaignColumns} FROM ovo_ops_campaigns
       WHERE organization_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
       ORDER BY id LIMIT $3`,
      [this.organizationId, afterId ?? null, boundedLimit(limit)],
    );
    return result.rows.map(campaignFromRow);
  }

  private async insertContacts(
    client: PoolClient,
    campaignId: string,
    contacts: readonly CampaignContactInput[],
  ): Promise<number> {
    let inserted = 0;
    for (const contact of contacts) {
      const result = await client.query(
        `INSERT INTO ovo_ops_campaign_contacts
          (id, campaign_id, source_row, phone_number, external_id, variables)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (campaign_id, phone_number) DO NOTHING`,
        [
          randomUUID(),
          campaignId,
          contact.sourceRow,
          contact.phoneNumber,
          contact.externalId ?? null,
          JSON.stringify(contact.variables),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  }

  async command(
    id: string,
    command: 'pause' | 'resume' | 'cancel',
    expectedVersion: number,
  ): Promise<CampaignCommandResult> {
    return transaction(this.pool, async (client) => {
      const current = await lockedCampaign(client, this.organizationId, id);
      if (Number(current.version) !== expectedVersion)
        return { kind: 'conflict', campaign: campaignFromRow(current) };
      const allowed =
        (command === 'pause' && ['scheduled', 'running'].includes(current.status)) ||
        (command === 'resume' && current.status === 'paused') ||
        (command === 'cancel' && ['scheduled', 'running', 'paused'].includes(current.status));
      if (!allowed) return { kind: 'conflict', campaign: campaignFromRow(current) };
      let next: CampaignStatus;
      if (command === 'pause') next = 'paused';
      else if (command === 'cancel') next = 'cancelled';
      else next = current.schedule_at.getTime() <= Date.now() ? 'running' : 'scheduled';
      const result = await client.query<CampaignRow>(
        `UPDATE ovo_ops_campaigns SET status = $3, version = version + 1, updated_at = now()
         WHERE id = $1 AND organization_id = $2 RETURNING ${campaignColumns}`,
        [id, this.organizationId, next],
      );
      return { kind: 'applied', campaign: campaignFromRow(result.rows[0]!) };
    });
  }

  async suppress(phoneNumber: string, reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('Suppression reason is required');
    const normalized = normalizePhoneNumber(phoneNumber);
    await transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-ops-suppression:${this.organizationId}:${normalized}`,
      ]);
      await client.query(
        `INSERT INTO ovo_ops_suppressions (organization_id, phone_number, reason) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, phone_number) DO UPDATE SET reason = EXCLUDED.reason`,
        [this.organizationId, normalized, reason.trim()],
      );
    });
  }

  async unsuppress(phoneNumber: string): Promise<boolean> {
    const normalized = normalizePhoneNumber(phoneNumber);
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-ops-suppression:${this.organizationId}:${normalized}`,
      ]);
      const result = await client.query(
        'DELETE FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2',
        [this.organizationId, normalized],
      );
      return result.rowCount === 1;
    });
  }

  async listSuppressions(limit = 25, afterPhone?: string): Promise<SuppressionRecord[]> {
    const result = await this.pool.query<{
      phone_number: string;
      reason: string;
      created_at: Date;
    }>(
      `SELECT phone_number, reason, created_at FROM ovo_ops_suppressions
       WHERE organization_id = $1 AND ($2::text IS NULL OR phone_number > $2)
       ORDER BY phone_number LIMIT $3`,
      [this.organizationId, afterPhone ?? null, boundedLimit(limit)],
    );
    return result.rows.map((row) => ({
      phoneNumber: row.phone_number,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }
}
