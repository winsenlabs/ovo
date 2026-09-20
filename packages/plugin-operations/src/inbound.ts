import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { boundedLimit, transaction } from './database.ts';
import type {
  InboundAdmission,
  InboundDecisionRecord,
  InboundOverflowPolicy,
  InboundPolicyRecord,
} from './types.ts';

interface AdmissionRow extends QueryResultRow {
  id: string;
  call_id: string;
  decision: InboundAdmission['kind'];
  slot_id: string | null;
  detail: Record<string, unknown>;
  released_at: Date | null;
  created_at: Date;
}

interface SlotRow extends QueryResultRow {
  slot_id: string;
  worker_id: string;
  generation: string;
  protected_until: Date;
}

export class InboundService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async getPolicy(): Promise<InboundPolicyRecord | undefined> {
    const result = await this.pool.query<{
      policy: InboundOverflowPolicy;
      version: string;
      updated_at: Date;
    }>(
      'SELECT policy, version, updated_at FROM ovo_ops_inbound_policy WHERE organization_id = $1',
      [this.organizationId],
    );
    const row = result.rows[0];
    return row
      ? { policy: row.policy, version: Number(row.version), updatedAt: row.updated_at }
      : undefined;
  }

  async setPolicy(
    policy: InboundOverflowPolicy,
    expectedVersion: number | null,
  ): Promise<InboundPolicyRecord | undefined> {
    validateOverflow(policy);
    const result =
      expectedVersion === null
        ? await this.pool.query<{
            policy: InboundOverflowPolicy;
            version: string;
            updated_at: Date;
          }>(
            `INSERT INTO ovo_ops_inbound_policy (organization_id, policy)
           VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING
           RETURNING policy, version, updated_at`,
            [this.organizationId, JSON.stringify(policy)],
          )
        : await this.pool.query<{
            policy: InboundOverflowPolicy;
            version: string;
            updated_at: Date;
          }>(
            `UPDATE ovo_ops_inbound_policy SET policy = $2::jsonb,
             version = version + 1, updated_at = now()
           WHERE organization_id = $1 AND version = $3
           RETURNING policy, version, updated_at`,
            [this.organizationId, JSON.stringify(policy), expectedVersion],
          );
    const row = result.rows[0];
    return row
      ? { policy: row.policy, version: Number(row.version), updatedAt: row.updated_at }
      : undefined;
  }

  async admitUsingPolicy(callId: string): Promise<InboundAdmission> {
    const policy = await this.getPolicy();
    if (!policy) throw new Error('Inbound overflow policy is not configured');
    return this.admit(callId, policy.policy);
  }

  async registerProtectedCapacity(input: {
    slotId: string;
    workerId: string;
    workerEndpoint: string;
    generation: number;
    ready: boolean;
    protectedUntil: Date;
  }): Promise<boolean> {
    if (
      !input.slotId ||
      !input.workerId ||
      !input.workerEndpoint ||
      !Number.isInteger(input.generation) ||
      input.generation < 1
    )
      throw new Error('Invalid capacity identity');
    if (input.ready && input.protectedUntil.getTime() <= Date.now())
      throw new Error('Ready capacity must have active task protection');
    const result = await this.pool.query(
      `INSERT INTO ovo_ops_inbound_capacity
        (slot_id, organization_id, worker_id, worker_endpoint, generation, ready, protected_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slot_id) DO UPDATE SET worker_id = EXCLUDED.worker_id,
         worker_endpoint = EXCLUDED.worker_endpoint,
         generation = EXCLUDED.generation, ready = EXCLUDED.ready,
         protected_until = EXCLUDED.protected_until,
         reservation_id = CASE
           WHEN ovo_ops_inbound_capacity.generation < EXCLUDED.generation THEN NULL
           ELSE ovo_ops_inbound_capacity.reservation_id
         END,
         reserved_call_id = CASE
           WHEN ovo_ops_inbound_capacity.generation < EXCLUDED.generation THEN NULL
           ELSE ovo_ops_inbound_capacity.reserved_call_id
         END,
         updated_at = now()
       WHERE ovo_ops_inbound_capacity.organization_id = EXCLUDED.organization_id
         AND ovo_ops_inbound_capacity.generation <= EXCLUDED.generation`,
      [
        input.slotId,
        this.organizationId,
        input.workerId,
        input.workerEndpoint,
        input.generation,
        input.ready,
        input.protectedUntil,
      ],
    );
    return result.rowCount === 1;
  }

  async suspendProtectedCapacity(input: {
    slotId: string;
    workerId: string;
    generation: number;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_ops_inbound_capacity
       SET ready = false, updated_at = now()
       WHERE organization_id = $1 AND slot_id = $2 AND worker_id = $3 AND generation = $4
         AND reservation_id IS NULL`,
      [this.organizationId, input.slotId, input.workerId, input.generation],
    );
    return result.rowCount === 1;
  }

  async admit(callId: string, overflow: InboundOverflowPolicy): Promise<InboundAdmission> {
    if (!callId) throw new Error('callId is required');
    validateOverflow(overflow);
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-ops-inbound:${this.organizationId}:${callId}`,
      ]);
      const existing = await client.query<AdmissionRow>(
        `SELECT id, call_id, decision, slot_id, detail, released_at, created_at
         FROM ovo_ops_inbound_admissions
         WHERE organization_id = $1 AND call_id = $2`,
        [this.organizationId, callId],
      );
      if (existing.rows[0]) return this.fromExisting(existing.rows[0]);
      const slot = await client.query<SlotRow>(
        `SELECT slot_id, worker_id, generation, protected_until FROM ovo_ops_inbound_capacity
         WHERE organization_id = $1 AND ready = true AND reservation_id IS NULL
           AND worker_endpoint IS NOT NULL AND protected_until > now()
         ORDER BY protected_until DESC, slot_id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [this.organizationId],
      );
      const admissionId = randomUUID();
      if (slot.rows[0]) {
        const selected = slot.rows[0];
        await client.query(
          `UPDATE ovo_ops_inbound_capacity SET reservation_id = $2, reserved_call_id = $3, updated_at = now()
           WHERE slot_id = $1`,
          [selected.slot_id, admissionId, callId],
        );
        await client.query(
          `INSERT INTO ovo_ops_inbound_admissions
            (id, organization_id, call_id, decision, slot_id, detail)
           VALUES ($1,$2,$3,'reserved',$4,$5::jsonb)`,
          [
            admissionId,
            this.organizationId,
            callId,
            selected.slot_id,
            JSON.stringify({
              workerId: selected.worker_id,
              generation: Number(selected.generation),
              protectedUntil: selected.protected_until.toISOString(),
            }),
          ],
        );
        return {
          kind: 'reserved',
          admissionId,
          slotId: selected.slot_id,
          workerId: selected.worker_id,
          generation: Number(selected.generation),
          protectedUntil: selected.protected_until,
        };
      }
      await client.query(
        `INSERT INTO ovo_ops_inbound_admissions
          (id, organization_id, call_id, decision, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [admissionId, this.organizationId, callId, overflow.kind, JSON.stringify(overflow)],
      );
      return { admissionId, ...overflow } as InboundAdmission;
    });
  }

  private fromExisting(row: AdmissionRow): InboundAdmission {
    if (row.decision === 'reserved') {
      return {
        kind: 'reserved',
        admissionId: row.id,
        slotId: row.slot_id!,
        workerId: String(row.detail.workerId),
        generation: Number(row.detail.generation),
        protectedUntil: new Date(String(row.detail.protectedUntil)),
      };
    }
    return { admissionId: row.id, ...row.detail } as InboundAdmission;
  }

  async release(admissionId: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const admission = await client.query<{ slot_id: string | null }>(
        `UPDATE ovo_ops_inbound_admissions SET released_at = now()
         WHERE id = $1 AND organization_id = $2 AND released_at IS NULL RETURNING slot_id`,
        [admissionId, this.organizationId],
      );
      if (!admission.rows[0]) return false;
      if (admission.rows[0].slot_id)
        await client.query(
          `UPDATE ovo_ops_inbound_capacity SET reservation_id = NULL, reserved_call_id = NULL, updated_at = now()
           WHERE slot_id = $1 AND reservation_id = $2`,
          [admission.rows[0].slot_id, admissionId],
        );
      return true;
    });
  }

  async releaseByCarrierCallId(carrierCallId: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const admission = await client.query<AdmissionRow>(
        `SELECT id, call_id, decision, slot_id, detail, released_at, created_at
         FROM ovo_ops_inbound_admissions
         WHERE organization_id = $1 AND call_id = $2 AND decision = 'reserved'
         FOR UPDATE`,
        [this.organizationId, carrierCallId],
      );
      const row = admission.rows[0];
      if (!row) return false;
      if (row.released_at) return true;
      await client.query(
        `UPDATE ovo_ops_inbound_admissions SET released_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [this.organizationId, row.id],
      );
      await client.query(
        `UPDATE ovo_ops_inbound_capacity SET reservation_id = NULL,
           reserved_call_id = NULL, updated_at = now()
         WHERE organization_id = $1 AND reservation_id = $2`,
        [this.organizationId, row.id],
      );
      return true;
    });
  }

  async readyProtectedCapacity(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ovo_ops_inbound_capacity
       WHERE organization_id = $1 AND ready = true AND reservation_id IS NULL
         AND worker_endpoint IS NOT NULL AND protected_until > now()`,
      [this.organizationId],
    );
    return Number(result.rows[0]!.count);
  }

  async listDecisions(limit = 25, afterId?: string): Promise<InboundDecisionRecord[]> {
    const result = await this.pool.query<AdmissionRow>(
      `SELECT id, call_id, decision, slot_id, detail, released_at, created_at
       FROM ovo_ops_inbound_admissions
       WHERE organization_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
       ORDER BY id LIMIT $3`,
      [this.organizationId, afterId ?? null, boundedLimit(limit)],
    );
    return result.rows.map((row) => ({
      admissionId: row.id,
      callId: row.call_id,
      decision: row.decision,
      slotId: row.slot_id ?? undefined,
      detail: row.detail,
      releasedAt: row.released_at ?? undefined,
      createdAt: row.created_at,
    }));
  }
}

function validateOverflow(overflow: InboundOverflowPolicy): void {
  if (overflow.kind === 'busy' && !overflow.reason) throw new Error('Busy reason is required');
  if (overflow.kind === 'wait') {
    if (
      !Number.isInteger(overflow.maxWaitMs) ||
      overflow.maxWaitMs < 1_000 ||
      overflow.maxWaitMs > 300_000
    )
      throw new Error('Wait duration is out of range');
    if (!overflow.announcement) throw new Error('Wait announcement is required');
  }
  if ((overflow.kind === 'callback' || overflow.kind === 'human') && !overflow.announcement)
    throw new Error('Overflow announcement is required');
  if (overflow.kind === 'callback' && !overflow.queue)
    throw new Error('Callback queue is required');
  if (overflow.kind === 'human' && !/^\+[1-9]\d{7,14}$/.test(overflow.target))
    throw new Error('Human target must be E.164');
}
