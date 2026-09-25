import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { InboundGatewayCall, InboundOverflowPolicy } from './types.ts';
import type { CallbackAdmissionRow } from './inbound-callback.ts';
import type { InboundGatewayDecision } from './types.ts';

export interface ExistingRow extends CallbackAdmissionRow {
  id: string;
  decision: 'reserved' | 'busy' | 'wait' | 'callback' | 'human';
  detail: Record<string, unknown>;
  job_id: string | null;
  session_id: string | null;
  release_id: string | null;
  route_version: string | null;
  carrier_plugin_id: string | null;
  carrier_binding_id: string | null;
  worker_id: string | null;
  worker_endpoint: string | null;
  wait_expires_at: Date | null;
}

export function existingDecision(row: ExistingRow): InboundGatewayDecision {
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

export async function recordBusy(
  client: PoolClient,
  organizationId: string,
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
      organizationId,
      input.carrierCallId,
      JSON.stringify({ kind: 'busy', reason, configuredPolicy }),
      input.fromNumber,
      input.toNumber,
    ],
  );
  return { kind: 'busy', admissionId, reason };
}
