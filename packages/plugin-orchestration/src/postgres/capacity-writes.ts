import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CapacityWriteAttempt, CapacityWriteGuard, CapacityWritePermit } from '../types.ts';
import { transaction } from './database.ts';

interface WriteRow {
  attempt_id: string;
  service_key: string;
  authority_id: string;
  epoch: string;
  desired_count: number;
  status: CapacityWriteAttempt['status'];
}

function fromRow(row: WriteRow): CapacityWriteAttempt {
  return {
    attemptId: row.attempt_id,
    serviceKey: row.service_key,
    authorityId: row.authority_id,
    epoch: Number(row.epoch),
    desiredCount: row.desired_count,
    status: row.status,
  };
}

async function pendingWrite(
  client: Pool | PoolClient,
  serviceKey: string,
  lock = false,
): Promise<CapacityWriteAttempt | undefined> {
  const result = await client.query<WriteRow>(
    `SELECT attempt_id, service_key, authority_id, epoch, desired_count, status
     FROM ovo_capacity_writes
     WHERE service_key = $1 AND status IN ('inflight', 'unknown')
     ORDER BY started_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [serviceKey],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : undefined;
}

export class PostgresCapacityWriteGuard implements CapacityWriteGuard {
  constructor(private readonly pool: Pool) {}

  async begin(input: {
    serviceKey: string;
    authorityId: string;
    epoch: number;
    desiredCount: number;
  }): Promise<CapacityWritePermit> {
    return transaction(this.pool, async (client) => {
      const lease = await client.query<{ authority_id: string; epoch: string; current: boolean }>(
        `SELECT authority_id, epoch, lease_expires_at > now() AS current
         FROM ovo_capacity_leases WHERE service_key = $1 FOR UPDATE`,
        [input.serviceKey],
      );
      const authority = lease.rows[0];
      if (
        !authority?.current ||
        authority.authority_id !== input.authorityId ||
        Number(authority.epoch) !== input.epoch
      ) {
        return { kind: 'stale_authority' };
      }
      const unresolved = await pendingWrite(client, input.serviceKey, true);
      if (unresolved) return { kind: 'unresolved', attempt: unresolved };

      const attempt: CapacityWriteAttempt = {
        attemptId: randomUUID(),
        serviceKey: input.serviceKey,
        authorityId: input.authorityId,
        epoch: input.epoch,
        desiredCount: input.desiredCount,
        status: 'inflight',
      };
      await client.query(
        `INSERT INTO ovo_capacity_writes
           (attempt_id, service_key, authority_id, epoch, desired_count, status)
         VALUES ($1, $2, $3, $4, $5, 'inflight')`,
        [attempt.attemptId, input.serviceKey, input.authorityId, input.epoch, input.desiredCount],
      );
      return { kind: 'permitted', attempt };
    });
  }

  async markApplied(attemptId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_capacity_writes SET status = 'applied', settled_at = now(), last_error = NULL
       WHERE attempt_id = $1 AND status = 'inflight'`,
      [attemptId],
    );
    return result.rowCount === 1;
  }

  async markUnknown(attemptId: string, error: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_capacity_writes SET status = 'unknown', last_error = $2
       WHERE attempt_id = $1 AND status = 'inflight'`,
      [attemptId, error.slice(0, 2000)],
    );
    return result.rowCount === 1;
  }

  pending(serviceKey: string): Promise<CapacityWriteAttempt | undefined> {
    return pendingWrite(this.pool, serviceKey);
  }
}
