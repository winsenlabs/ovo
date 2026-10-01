import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { transaction as sharedTransaction } from '@winsendotai/ovo-plugin-kit/postgres-transaction';
import type { DurableJob } from '../types.ts';

export interface JobRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: DurableJob['status'];
  owner_id: string | null;
  owner_epoch: string;
  lease_expires_at: Date | null;
  dial_request_id: string | null;
  carrier_call_id: string | null;
  last_error: string | null;
}

export const jobColumns = `id, workspace_id, idempotency_key, payload, status, owner_id,
  owner_epoch, lease_expires_at, dial_request_id, carrier_call_id, last_error`;

export function fromJobRow(row: JobRow): DurableJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    status: row.status,
    ownerId: row.owner_id ?? undefined,
    ownerEpoch: Number(row.owner_epoch),
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    dialRequestId: row.dial_request_id ?? undefined,
    carrierCallId: row.carrier_call_id ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

export function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return sharedTransaction<PoolClient, T>(pool, work);
}
