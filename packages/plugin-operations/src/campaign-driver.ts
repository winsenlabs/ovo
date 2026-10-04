import type { CarrierControlFactory } from '@winsendotai/ovo-contracts';
import type { Pool, PoolClient } from 'pg';
import { CampaignAdmissionService } from './campaign-admission.ts';
import { campaignColumns, type CampaignRow } from './campaign-model.ts';
import { transaction } from './database.ts';

export interface CampaignCapacityPort {
  admissionSnapshot(): Promise<{ readyIdleSlots: number; eligibleQueuedJobs: number }>;
}

type DriverCampaign = CampaignRow;

export class CampaignDriver {
  private readonly admission: CampaignAdmissionService;

  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly capacity: CampaignCapacityPort,
    private readonly controls: ReadonlyMap<string, CarrierControlFactory>,
  ) {
    this.admission = new CampaignAdmissionService(pool, organizationId);
  }

  async tick(signal: AbortSignal): Promise<number> {
    if (signal.aborted) return 0;
    return transaction(this.pool, async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext('ovo-campaign-driver:' || $1)) AS acquired",
        [this.organizationId],
      );
      if (!lock.rows[0]?.acquired) return 0;
      const campaigns = await client.query<DriverCampaign>(
        `SELECT ${campaignColumns}
         FROM ovo_ops_campaigns WHERE organization_id = $1
           AND (status = 'running' OR (status = 'scheduled' AND schedule_at <= now()))
         ORDER BY schedule_at, id FOR UPDATE SKIP LOCKED`,
        [this.organizationId],
      );
      let admitted = 0;
      for (const campaign of campaigns.rows) {
        if (signal.aborted) break;
        await this.admission.reclassifyContacts(client, campaign);
        if (await this.completeIfDrained(client, campaign.id)) continue;
        if (!campaign.carrier_id) {
          await this.refuse(client, campaign.id, 'Campaign has no carrier snapshot');
          continue;
        }
        const matches = [...this.controls.values()].filter(
          (item) => item.capabilities.carrierId === campaign.carrier_id,
        );
        if (matches.length !== 1) {
          await this.refuse(
            client,
            campaign.id,
            `Campaign carrier ${campaign.carrier_id} is missing or ambiguous`,
          );
          continue;
        }
        const carrier = matches[0]!;
        const cps =
          campaign.binding_cps === null
            ? carrier.capabilities.pacing.cps
            : Number(campaign.binding_cps);
        if (!Number.isFinite(cps) || cps <= 0) {
          await this.refuse(client, campaign.id, 'Campaign pacing cps is invalid');
          continue;
        }
        if (campaign.driver_error) await this.refuse(client, campaign.id, null);
        const capacity = await this.capacity.admissionSnapshot();
        const pending = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ovo_ops_outbox o
           JOIN ovo_ops_campaigns c ON c.id::text = split_part(o.dedup_key, ':', 1)
           JOIN ovo_ops_campaign_contacts t ON t.campaign_id = c.id
             AND t.id::text = split_part(o.dedup_key, ':', 2)
           WHERE c.organization_id = $1 AND o.topic = 'campaign.dial.candidate'
             AND o.sent_at IS NULL AND t.state IN ('admitted','dialing')
             AND t.owner_epoch::text = split_part(o.dedup_key, ':', 3)
             AND t.admission_campaign_version = c.version`,
          [this.organizationId],
        );
        const ready = Math.max(
          0,
          capacity.readyIdleSlots - capacity.eligibleQueuedJobs - Number(pending.rows[0]!.count),
        );
        if (ready === 0) continue;
        const active = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ovo_ops_campaign_contacts
           WHERE campaign_id = $1 AND state IN ('admitted','dialing','active','unknown')`,
          [campaign.id],
        );
        const available = Math.max(0, campaign.max_concurrency - Number(active.rows[0]!.count));
        if (available === 0) continue;
        const tokens = await this.refill(client, campaign, cps);
        const headroom = Math.max(0, Math.min(available, ready, Math.floor(tokens)));
        for (let index = 0; index < headroom; index += 1) {
          if (signal.aborted) break;
          const result = await this.admission.admitWithClient(
            client,
            campaign.id,
            `campaign-driver:${this.organizationId}`,
            300_000,
          );
          if (result.kind !== 'admitted') break;
          const debited = await client.query(
            `UPDATE ovo_ops_pacing_buckets SET tokens = tokens - 1
             WHERE organization_id = $1 AND carrier_id = $2 AND binding_id IS NOT DISTINCT FROM $3
               AND from_number = $4 AND tokens >= 1`,
            [
              this.organizationId,
              campaign.carrier_id,
              campaign.carrier_binding_id,
              campaign.from_number,
            ],
          );
          if (debited.rowCount !== 1) throw new Error('Campaign pacing token was not reserved');
          admitted += 1;
        }
      }
      return admitted;
    });
  }

  private async refuse(client: PoolClient, id: string, reason: string | null): Promise<void> {
    await client.query('UPDATE ovo_ops_campaigns SET driver_error = $2 WHERE id = $1', [
      id,
      reason,
    ]);
  }

  private async completeIfDrained(client: PoolClient, id: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE ovo_ops_campaigns k SET status = 'completed', version = version + 1,
         driver_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'
         AND NOT EXISTS (SELECT 1 FROM ovo_ops_campaign_contacts c WHERE c.campaign_id = k.id
           AND c.state NOT IN ('succeeded','failed','cancelled','superseded','suppressed','exhausted'))
         AND NOT EXISTS (SELECT 1 FROM ovo_ops_attempts a
           WHERE a.campaign_id = k.id AND a.status = 'unknown')`,
      [id],
    );
    return result.rowCount === 1;
  }

  private async refill(client: PoolClient, campaign: DriverCampaign, cps: number): Promise<number> {
    const row = await client.query<{ tokens: string }>(
      `INSERT INTO ovo_ops_pacing_buckets
         (organization_id, carrier_id, binding_id, from_number, tokens, refilled_at)
       VALUES ($1,$2,$3,$4,GREATEST(1,$5::numeric),now())
       ON CONFLICT (organization_id, carrier_id, binding_id, from_number)
         DO UPDATE SET tokens = LEAST(GREATEST(1,$5::numeric),
             ovo_ops_pacing_buckets.tokens +
             GREATEST(0, EXTRACT(EPOCH FROM now() - ovo_ops_pacing_buckets.refilled_at)) * $5::numeric),
           refilled_at = now()
       RETURNING tokens::text`,
      [
        this.organizationId,
        campaign.carrier_id,
        campaign.carrier_binding_id,
        campaign.from_number,
        cps,
      ],
    );
    return Number(row.rows[0]!.tokens);
  }
}
