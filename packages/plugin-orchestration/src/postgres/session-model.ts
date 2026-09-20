import type { SessionRoute, SessionRouteStatus } from '../types.ts';

export interface SessionRouteRow {
  session_id: string;
  job_id: string;
  organization_id: string;
  worker_id: string;
  worker_endpoint: string;
  owner_epoch: string | number;
  generation: string | number;
  dial_request_id: string;
  carrier_call_id: string | null;
  status: SessionRouteStatus;
  handshake_expires_at: Date;
  handshake_claimed_at: Date | null;
  terminal_at: Date | null;
  terminal_reason: string | null;
  released_at: Date | null;
}

export const sessionRouteColumns = `session_id, job_id, organization_id, worker_id,
  worker_endpoint, owner_epoch, generation, dial_request_id, carrier_call_id, status,
  handshake_expires_at, handshake_claimed_at, terminal_at, terminal_reason, released_at`;

export function fromSessionRouteRow(row: SessionRouteRow): SessionRoute {
  return {
    sessionId: row.session_id,
    jobId: row.job_id,
    organizationId: row.organization_id,
    workerId: row.worker_id,
    workerEndpoint: row.worker_endpoint,
    ownerEpoch: Number(row.owner_epoch),
    generation: Number(row.generation),
    dialRequestId: row.dial_request_id,
    carrierCallId: row.carrier_call_id ?? undefined,
    status: row.status,
    handshakeExpiresAt: row.handshake_expires_at,
    handshakeClaimedAt: row.handshake_claimed_at ?? undefined,
    terminalAt: row.terminal_at ?? undefined,
    terminalReason: row.terminal_reason ?? undefined,
    releasedAt: row.released_at ?? undefined,
  };
}
