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
  CampaignContactRecord,
  CampaignStatus,
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
    const digest = inputDigest({ config: digestConfig(config), contacts: normalized });
    return transaction(this.pool, async (client) => {
      const status: CampaignStatus = scheduleAt.getTime() <= Date.now() ? 'running' : 'scheduled';
      const inserted = await client.query<CampaignRow>(
        `INSERT INTO ovo_ops_campaigns (
          id, organization_id, operation_id, input_digest, name, agent_release_id, from_number, status, schedule_at, timezone,
          per_number_attempt_limit, max_attempts_total, max_attempts_per_local_day, active_call_policy,
          max_concurrency, carrier_plugin_id, carrier_id, carrier_binding_id, binding_cps,
          calling_window, variables_schema
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
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
          config.maxConcurrency ?? 1,
          config.carrierPluginId ?? null,
          config.carrierId ?? null,
          config.carrierBindingId ?? null,
          config.bindingCps ?? null,
          config.callingWindow ? JSON.stringify(config.callingWindow) : null,
          config.variablesSchema ? JSON.stringify(config.variablesSchema) : null,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<CampaignRow>(
          `SELECT ${campaignColumns} FROM ovo_ops_campaigns
           WHERE organization_id = $1 AND operation_id = $2`,
          [this.organizationId, config.operationId],
        );
        const old = existing.rows[0];
        if (!old || (old.input_digest !== digest && !matchesLegacyDigest(old, config, normalized)))
          throw new Error('Campaign operationId collision');
        return campaignFromRow(old);
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

  async patchConcurrency(
    id: string,
    expectedVersion: number,
    maxConcurrency: number,
  ): Promise<CampaignCommandResult> {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 1_000)
      throw new TypeError('Campaign maxConcurrency must be between 1 and 1000');
    return transaction(this.pool, async (client) => {
      const current = await lockedCampaign(client, this.organizationId, id);
      if (
        Number(current.version) !== expectedVersion ||
        ['completed', 'cancelled'].includes(current.status)
      )
        return { kind: 'conflict', campaign: campaignFromRow(current) };
      const result = await client.query<CampaignRow>(
        `UPDATE ovo_ops_campaigns SET max_concurrency = $2, version = version + 1,
           updated_at = now() WHERE id = $1 RETURNING ${campaignColumns}`,
        [id, maxConcurrency],
      );
      await client.query(
        `UPDATE ovo_ops_campaign_contacts SET admission_campaign_version = $2
         WHERE campaign_id = $1 AND state IN ('admitted','dialing')`,
        [id, result.rows[0]!.version],
      );
      return { kind: 'applied', campaign: campaignFromRow(result.rows[0]!) };
    });
  }

  async listContacts(
    campaignId: string,
    limit = 25,
    afterSourceRow?: number,
  ): Promise<CampaignContactRecord[]> {
    await this.get(campaignId);
    const result = await this.pool.query<{
      id: string;
      source_row: number;
      phone_number: string;
      external_id: string | null;
      variables: Record<string, string>;
      state: CampaignContactRecord['state'];
    }>(
      `SELECT id, source_row, phone_number, external_id, variables, state
       FROM ovo_ops_campaign_contacts WHERE campaign_id = $1 AND ($2::integer IS NULL OR source_row > $2)
       ORDER BY source_row, id LIMIT $3`,
      [campaignId, afterSourceRow ?? null, boundedLimit(limit)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sourceRow: row.source_row,
      phoneNumber: row.phone_number,
      ...(row.external_id ? { externalId: row.external_id } : {}),
      variables: row.variables,
      state: row.state,
    }));
  }
}

/**
 * The idempotency digest. The variables schema follows from the release id, and a campaign with no
 * calling window digests exactly as it did before windows existed, so retries keep matching.
 */
function digestConfig(config: CampaignConfig) {
  const { variablesSchema: _variablesSchema, callingWindow, ...rest } = config;
  return callingWindow ? { ...rest, callingWindow } : rest;
}

function matchesLegacyDigest(
  row: CampaignRow,
  config: CampaignConfig,
  contacts: readonly CampaignContactInput[],
): boolean {
  if (row.carrier_id !== null || row.max_concurrency !== 1 || (config.maxConcurrency ?? 1) !== 1)
    return false;
  if (
    config.carrierPluginId != null ||
    config.carrierId != null ||
    config.carrierBindingId != null ||
    config.bindingCps != null ||
    config.callingWindow
  )
    return false;
  const {
    maxConcurrency: _maxConcurrency,
    carrierPluginId: _carrierPluginId,
    carrierId: _carrierId,
    carrierBindingId: _carrierBindingId,
    bindingCps: _bindingCps,
    ...legacyConfig
  } = digestConfig(config);
  return row.input_digest === inputDigest({ config: legacyConfig, contacts });
}
