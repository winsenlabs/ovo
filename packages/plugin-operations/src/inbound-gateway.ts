import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { transaction } from './database.ts';
import { confirmInboundCallback, type CallbackAdmissionRow } from './inbound-callback.ts';
import { provisionInboundSession } from './inbound-session.ts';
import type { InboundGatewayCall, InboundGatewayDecision, InboundOverflowPolicy } from './types.ts';

interface ExistingRow extends CallbackAdmissionRow {
  id: string;
  decision: 'reserved' | 'busy' | 'wait' | 'callback' | 'human';
  detail: Record<string, unknown>;
  job_id: string | null;
  session_id: string | null;
  release_id: string | null;
  route_version: string | null;
  worker_id: string | null;
  worker_endpoint: string | null;
  wait_expires_at: Date | null;
}

interface RouteRow extends QueryResultRow {
  release_id: string;
  variables: Record<string, string>;
  version: string;
}

interface CapacityRow extends QueryResultRow {
  slot_id: string;
  worker_id: string;
  worker_endpoint: string;
  generation: string;
  protected_until: Date;
}

interface PolicyRow extends QueryResultRow {
  policy: InboundOverflowPolicy;
}

const existingColumns = `a.id, a.call_id, a.decision, a.detail, a.job_id, a.session_id,
  a.release_id, a.route_version, a.variables, a.from_number, a.to_number, a.wait_expires_at,
  a.callback_campaign_id, a.callback_contact_id, a.callback_job_id,
  c.worker_id, c.worker_endpoint`;

function existingDecision(row: ExistingRow): InboundGatewayDecision {
  if (row.decision === 'reserved') {
    if (!row.job_id || !row.session_id || !row.release_id || !row.route_version || !row.worker_id)
      throw new Error('Persisted inbound reservation is incomplete');
    return {
      kind: 'reserved',
      admissionId: row.id,
      jobId: row.job_id,
      sessionId: row.session_id,
      workerId: row.worker_id,
      workerEndpoint: row.worker_endpoint ?? '',
      releaseId: row.release_id,
      routeVersion: Number(row.route_version),
    };
  }
  if (row.decision === 'human')
    return {
      kind: 'human',
      admissionId: row.id,
      target: String(row.detail.target ?? ''),
      announcement: String(row.detail.announcement ?? ''),
    };
  if (row.decision === 'wait') {
    if (!row.wait_expires_at) throw new Error('Persisted inbound wait is incomplete');
    return {
      kind: 'wait',
      admissionId: row.id,
      announcement: String(row.detail.announcement ?? ''),
      expiresAt: row.wait_expires_at,
      pollAfterMs: Math.max(1_000, Math.min(5_000, row.wait_expires_at.getTime() - Date.now())),
    };
  }
  if (row.decision === 'callback') {
    const state = String(row.detail.state ?? 'prompt');
    return {
      kind: 'callback',
      admissionId: row.id,
      state:
        state === 'queued' || state === 'declined' || state === 'suppressed' ? state : 'prompt',
      announcement: String(row.detail.announcement ?? ''),
      campaignId: row.callback_campaign_id ?? undefined,
      contactId: row.callback_contact_id ?? undefined,
      jobId: row.callback_job_id ?? undefined,
    };
  }
  return { kind: 'busy', admissionId: row.id, reason: String(row.detail.reason ?? 'busy') };
}

export class InboundGatewayAdmissionService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly callbackOutbound: {
      enabled: boolean;
      permittedFromNumbers: readonly string[];
    } = { enabled: false, permittedFromNumbers: [] },
  ) {}

  async admit(input: InboundGatewayCall): Promise<InboundGatewayDecision> {
    if (
      !Number.isInteger(input.handshakeTtlMs) ||
      input.handshakeTtlMs < 5_000 ||
      input.handshakeTtlMs > 300_000
    )
      throw new Error('handshakeTtlMs must be between 5000 and 300000');
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-inbound-call:${this.organizationId}:${input.carrierCallId}`,
      ]);
      const prior = await this.existing(client, input.carrierCallId);
      if (prior) return this.resume(client, input, prior);
      const route = await client.query<RouteRow>(
        `SELECT release_id, variables, version FROM ovo_ops_inbound_routes
         WHERE organization_id = $1 AND phone_number = $2 AND enabled = true`,
        [this.organizationId, input.toNumber],
      );
      if (!route.rows[0]) return this.recordBusy(client, input, 'inbound_number_not_routed');
      const capacity = await this.reserveCapacity(client, input.handshakeTtlMs);
      if (!capacity) return this.overflow(client, input, route.rows[0]);
      return provisionInboundSession(client, this.organizationId, input, route.rows[0], capacity);
    });
  }

  async confirmCallback(
    input: InboundGatewayCall & { digits: string },
  ): Promise<InboundGatewayDecision> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-inbound-call:${this.organizationId}:${input.carrierCallId}`,
      ]);
      const prior = await this.existing(client, input.carrierCallId, true);
      if (!prior || prior.from_number !== input.fromNumber || prior.to_number !== input.toNumber)
        throw new Error('Callback admission identity does not match');
      return confirmInboundCallback(client, this.organizationId, prior, input.digits);
    });
  }

  private async existing(
    client: PoolClient,
    callId: string,
    lock = false,
  ): Promise<ExistingRow | undefined> {
    const result = await client.query<ExistingRow>(
      `SELECT ${existingColumns} FROM ovo_ops_inbound_admissions a
       LEFT JOIN ovo_ops_inbound_capacity c ON c.slot_id = a.slot_id
       WHERE a.organization_id = $1 AND a.call_id = $2${lock ? ' FOR UPDATE OF a' : ''}`,
      [this.organizationId, callId],
    );
    return result.rows[0];
  }

  private async resume(
    client: PoolClient,
    input: InboundGatewayCall,
    prior: ExistingRow,
  ): Promise<InboundGatewayDecision> {
    if (prior.from_number && prior.from_number !== input.fromNumber)
      throw new Error('Inbound caller identity changed');
    if (prior.to_number && prior.to_number !== input.toNumber)
      throw new Error('Inbound called number changed');
    if (prior.decision !== 'wait') return existingDecision(prior);
    if (!prior.wait_expires_at || prior.wait_expires_at.getTime() <= Date.now()) {
      const detail = { kind: 'busy', reason: 'wait_expired', configuredPolicy: prior.detail };
      await client.query(
        `UPDATE ovo_ops_inbound_admissions SET decision = 'busy', detail = $2::jsonb
         WHERE id = $1 AND decision = 'wait'`,
        [prior.id, JSON.stringify(detail)],
      );
      return { kind: 'busy', admissionId: prior.id, reason: 'wait_expired' };
    }
    const capacity = await this.reserveCapacity(client, input.handshakeTtlMs);
    if (!capacity) return existingDecision(prior);
    if (!prior.release_id || !prior.route_version || !prior.variables)
      throw new Error('Persisted inbound wait route is incomplete');
    return provisionInboundSession(
      client,
      this.organizationId,
      input,
      {
        release_id: prior.release_id,
        variables: prior.variables,
        version: prior.route_version,
      },
      capacity,
      prior.id,
    );
  }

  private async reserveCapacity(
    client: PoolClient,
    ttlMs: number,
  ): Promise<CapacityRow | undefined> {
    const result = await client.query<CapacityRow>(
      `SELECT slot_id, worker_id, worker_endpoint, generation, protected_until
       FROM ovo_ops_inbound_capacity
       WHERE organization_id = $1 AND ready = true AND reservation_id IS NULL
         AND worker_endpoint IS NOT NULL
         AND protected_until > now() + ($2 * interval '1 millisecond')
       ORDER BY protected_until DESC, slot_id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [this.organizationId, ttlMs],
    );
    return result.rows[0];
  }

  private async overflow(
    client: PoolClient,
    input: InboundGatewayCall,
    route: RouteRow,
  ): Promise<InboundGatewayDecision> {
    const policy = await client.query<PolicyRow>(
      'SELECT policy FROM ovo_ops_inbound_policy WHERE organization_id = $1',
      [this.organizationId],
    );
    const configured = policy.rows[0]?.policy;
    if (configured?.kind === 'wait') {
      const admissionId = randomUUID();
      const expiresAt = new Date(Date.now() + configured.maxWaitMs);
      await client.query(
        `INSERT INTO ovo_ops_inbound_admissions
           (id, organization_id, call_id, decision, detail, from_number, to_number,
            route_version, release_id, variables, wait_expires_at)
         VALUES ($1,$2,$3,'wait',$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          admissionId,
          this.organizationId,
          input.carrierCallId,
          JSON.stringify(configured),
          input.fromNumber,
          input.toNumber,
          route.version,
          route.release_id,
          JSON.stringify(route.variables),
          expiresAt,
        ],
      );
      return {
        kind: 'wait',
        admissionId,
        announcement: configured.announcement,
        expiresAt,
        pollAfterMs: Math.max(1_000, Math.min(5_000, configured.maxWaitMs)),
      };
    }
    if (configured?.kind === 'callback') {
      if (
        !this.callbackOutbound.enabled ||
        !this.callbackOutbound.permittedFromNumbers.includes(input.toNumber)
      )
        return this.recordBusy(client, input, 'callback_outbound_not_configured', configured);
      const admissionId = randomUUID();
      const detail = { ...configured, state: 'prompt' };
      await client.query(
        `INSERT INTO ovo_ops_inbound_admissions
           (id, organization_id, call_id, decision, detail, from_number, to_number,
            route_version, release_id, variables)
         VALUES ($1,$2,$3,'callback',$4::jsonb,$5,$6,$7,$8,$9::jsonb)`,
        [
          admissionId,
          this.organizationId,
          input.carrierCallId,
          JSON.stringify(detail),
          input.fromNumber,
          input.toNumber,
          route.version,
          route.release_id,
          JSON.stringify(route.variables),
        ],
      );
      return {
        kind: 'callback',
        admissionId,
        state: 'prompt',
        announcement: configured.announcement,
      };
    }
    if (configured?.kind === 'human') {
      const admissionId = randomUUID();
      await client.query(
        `INSERT INTO ovo_ops_inbound_admissions
           (id, organization_id, call_id, decision, detail, from_number, to_number)
         VALUES ($1, $2, $3, 'human', $4::jsonb, $5, $6)`,
        [
          admissionId,
          this.organizationId,
          input.carrierCallId,
          JSON.stringify(configured),
          input.fromNumber,
          input.toNumber,
        ],
      );
      return {
        kind: 'human',
        admissionId,
        target: configured.target,
        announcement: configured.announcement,
      };
    }
    const reason =
      configured?.kind === 'busy' ? configured.reason : 'inbound_policy_not_configured';
    return this.recordBusy(client, input, reason, configured);
  }

  private async recordBusy(
    client: PoolClient,
    input: InboundGatewayCall,
    reason: string,
    configuredPolicy?: InboundOverflowPolicy,
  ): Promise<InboundGatewayDecision> {
    const admissionId = randomUUID();
    await client.query(
      `INSERT INTO ovo_ops_inbound_admissions
         (id, organization_id, call_id, decision, detail, from_number, to_number)
       VALUES ($1, $2, $3, 'busy', $4::jsonb, $5, $6)`,
      [
        admissionId,
        this.organizationId,
        input.carrierCallId,
        JSON.stringify({ kind: 'busy', reason, configuredPolicy }),
        input.fromNumber,
        input.toNumber,
      ],
    );
    return { kind: 'busy', admissionId, reason };
  }
}
