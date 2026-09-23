import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { InboundGatewayCall, InboundGatewayDecision } from './types.ts';

export interface InboundRouteSnapshot {
  release_id: string;
  variables: Record<string, string>;
  version: string;
  carrier_plugin_id: string | null;
  carrier_binding_id: string | null;
}

export interface InboundCapacityReservation {
  slot_id: string;
  worker_id: string;
  worker_endpoint: string;
  generation: string;
  protected_until: Date;
}

export async function provisionInboundSession(
  client: PoolClient,
  organizationId: string,
  input: InboundGatewayCall,
  route: InboundRouteSnapshot,
  capacity: InboundCapacityReservation,
  existingAdmissionId?: string,
): Promise<InboundGatewayDecision> {
  const admissionId = existingAdmissionId ?? randomUUID();
  const jobId = randomUUID();
  const sessionId = randomUUID();
  const epoch = Number(capacity.generation);
  const requestId = `inbound:${input.carrierCallId}`;
  const payload = {
    kind: 'inbound_call',
    callId: jobId,
    releaseId: route.release_id,
    variables: route.variables,
    from: input.fromNumber,
    to: input.toNumber,
    carrierCallId: input.carrierCallId,
    inboundAdmissionId: admissionId,
    carrierPluginId: route.carrier_plugin_id,
    carrierBindingId: route.carrier_binding_id,
  };
  await client.query(
    `INSERT INTO ovo_jobs
       (id, workspace_id, idempotency_key, payload, status, owner_id, owner_epoch,
        lease_expires_at, dial_request_id, carrier_call_id,
        carrier_plugin_id, carrier_binding_id, binding_id)
     VALUES ($1, $2, $3, $4::jsonb, 'accepted', $5, $6, $7, $8, $9, $10, $11, $11)`,
    [
      jobId,
      organizationId,
      requestId,
      JSON.stringify(payload),
      capacity.worker_id,
      epoch,
      capacity.protected_until,
      requestId,
      input.carrierCallId,
      route.carrier_plugin_id,
      route.carrier_binding_id,
    ],
  );
  await client.query(
    `INSERT INTO ovo_session_routes
       (session_id, job_id, organization_id, worker_id, worker_endpoint, owner_epoch,
        generation, dial_request_id, carrier_call_id, status, handshake_token_hash,
        handshake_expires_at, accepted_at, carrier_plugin_id, carrier_binding_id, binding_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, 'accepted', $9,
        now() + ($10 * interval '1 millisecond'), now(), $11, $12, $12)`,
    [
      sessionId,
      jobId,
      organizationId,
      capacity.worker_id,
      capacity.worker_endpoint,
      epoch,
      requestId,
      input.carrierCallId,
      input.routeTokenHash,
      input.handshakeTtlMs,
      route.carrier_plugin_id,
      route.carrier_binding_id,
    ],
  );
  const detail = {
    kind: 'reserved',
    releaseId: route.release_id,
    routeVersion: Number(route.version),
  };
  if (existingAdmissionId) {
    await client.query(
      `UPDATE ovo_ops_inbound_admissions SET decision = 'reserved', slot_id = $2,
         detail = $3::jsonb, job_id = $4, session_id = $5
       WHERE id = $1 AND decision = 'wait'`,
      [admissionId, capacity.slot_id, JSON.stringify(detail), jobId, sessionId],
    );
  } else {
    await client.query(
      `INSERT INTO ovo_ops_inbound_admissions
         (id, organization_id, call_id, decision, slot_id, detail, from_number, to_number,
          route_version, release_id, variables, job_id, session_id)
       VALUES ($1, $2, $3, 'reserved', $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [
        admissionId,
        organizationId,
        input.carrierCallId,
        capacity.slot_id,
        JSON.stringify(detail),
        input.fromNumber,
        input.toNumber,
        route.version,
        route.release_id,
        JSON.stringify(route.variables),
        jobId,
        sessionId,
      ],
    );
  }
  await client.query(
    `UPDATE ovo_ops_inbound_capacity SET reservation_id = $3,
       reserved_call_id = $4, updated_at = now()
     WHERE organization_id = $1 AND slot_id = $2 AND reservation_id IS NULL`,
    [organizationId, capacity.slot_id, admissionId, input.carrierCallId],
  );
  await client.query(
    `INSERT INTO ovo_ops_call_bindings
       (organization_id, internal_call_id, carrier_call_id, release_id, binding_receipt_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      organizationId,
      jobId,
      input.carrierCallId,
      route.release_id,
      `inbound-webhook:${createHash('sha256').update(requestId).digest('hex')}`,
    ],
  );
  return {
    kind: 'reserved',
    admissionId,
    jobId,
    sessionId,
    workerId: capacity.worker_id,
    workerEndpoint: capacity.worker_endpoint,
    releaseId: route.release_id,
    routeVersion: Number(route.version),
  };
}
