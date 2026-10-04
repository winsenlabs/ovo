import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { transaction } from './database.ts';
import { confirmInboundCallback } from './inbound-callback.ts';
import { existingDecision, recordBusy, type ExistingRow } from './inbound-existing.ts';
import {
  InstalledInboundCarrierPlugins,
  selectInboundCarrierRoute,
  type InboundCarrierRoute,
} from './inbound-carrier.ts';
import { provisionInboundSession } from './inbound-session.ts';
import { inboundOverflow } from './inbound-overflow.ts';
import type { InboundGatewayCall, InboundGatewayDecision } from './types.ts';

interface CapacityRow extends QueryResultRow {
  slot_id: string;
  worker_id: string;
  worker_endpoint: string;
  generation: string;
  protected_until: Date;
}

const existingColumns = `a.id, a.call_id, a.decision, a.detail, a.job_id, a.session_id,
  a.release_id, a.route_version, a.variables, a.carrier_plugin_id, a.carrier_binding_id,
  a.from_number, a.to_number, a.wait_expires_at,
  a.callback_campaign_id, a.callback_contact_id, a.callback_job_id,
  c.worker_id, c.worker_endpoint`;
type InstalledCarrier = { pluginId: string; carrierId: string };

export class InboundGatewayAdmissionService {
  private readonly installedCarrierPlugins = new InstalledInboundCarrierPlugins();
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly callbackOutbound: {
      enabled: boolean;
      permittedFromNumbers: readonly string[];
    } = { enabled: false, permittedFromNumbers: [] },
  ) {}

  /** The host supplies controls it actually composed; an unknown explicit route never admits. */
  setInstalledCarrierPlugins(
    plugins: Iterable<InstalledCarrier>,
    environmentCarrierId?: string,
  ): void {
    this.installedCarrierPlugins.set(plugins, environmentCarrierId);
  }

  assertArmed(): void {
    this.installedCarrierPlugins.assertArmed();
  }

  async admit(input: InboundGatewayCall): Promise<InboundGatewayDecision> {
    if (
      !Number.isInteger(input.handshakeTtlMs) ||
      input.handshakeTtlMs < 5_000 ||
      input.handshakeTtlMs > 300_000
    )
      throw new Error('handshakeTtlMs must be between 5000 and 300000');
    this.assertArmed();
    // Resolve the route and carrier before the write transaction. Configuration
    // failures become durable refusals instead of rolling back the admission row.
    const route = await selectInboundCarrierRoute(this.pool, this.organizationId, input.toNumber);
    const carrier = route
      ? this.installedCarrierPlugins.resolve(route.carrier_plugin_id)
      : undefined;
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-inbound-call:${this.organizationId}:${input.carrierCallId}`,
      ]);
      const prior = await this.existing(client, input.carrierCallId);
      if (prior) return this.resume(client, input, prior);
      if (!route)
        return recordBusy(client, this.organizationId, input, 'inbound_number_not_routed');
      if (carrier?.kind === 'refused')
        return recordBusy(client, this.organizationId, input, carrier.reason);
      if (!carrier || carrier.kind !== 'selected')
        throw new Error('Inbound carrier selection is missing');
      const capacity = await this.reserveCapacity(client, input.handshakeTtlMs);
      if (!capacity)
        return inboundOverflow(client, this.organizationId, input, route, this.callbackOutbound);
      return provisionInboundSession(
        client,
        this.organizationId,
        input,
        { ...route, carrier_id: carrier.carrierId },
        capacity,
      );
    });
  }

  async confirmCallback(
    input: InboundGatewayCall & { digits: string },
  ): Promise<InboundGatewayDecision> {
    this.assertArmed();
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
    if (!prior.release_id || !prior.route_version || !prior.variables)
      throw new Error('Persisted inbound wait route is incomplete');
    const carrier = this.installedCarrierPlugins.resolve(prior.carrier_plugin_id);
    if (carrier.kind === 'refused') {
      await client.query(
        `UPDATE ovo_ops_inbound_admissions SET decision = 'busy', detail = $2::jsonb
         WHERE id = $1 AND decision = 'wait'`,
        [prior.id, JSON.stringify({ kind: 'busy', reason: carrier.reason })],
      );
      return { kind: 'busy', admissionId: prior.id, reason: carrier.reason };
    }
    const capacity = await this.reserveCapacity(client, input.handshakeTtlMs);
    if (!capacity) return existingDecision(prior);
    return provisionInboundSession(
      client,
      this.organizationId,
      input,
      {
        release_id: prior.release_id,
        variables: prior.variables,
        version: prior.route_version,
        carrier_plugin_id: prior.carrier_plugin_id,
        carrier_binding_id: prior.carrier_binding_id,
        carrier_id: carrier.carrierId,
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
}
