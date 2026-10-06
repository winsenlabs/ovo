import type { Pool } from 'pg';
import type { CapacitySignal } from '@winsendotai/ovo-contracts';
import { transaction } from './database.ts';

export interface WorkerReport {
  workerId: string;
  state: 'ready_idle' | 'reserved' | 'active' | 'starting' | 'draining';
  ownershipEpoch: number;
  leaseMs: number;
  metadata?: Record<string, unknown>;
}

export interface CapacitySnapshot {
  observedAtMs: number;
  counts: {
    readyIdle: number;
    reserved: number;
    active: number;
    starting: number;
    draining: number;
    total: number;
  };
  eligibleUnclaimed: number;
  oldestEligibleJobAgeSeconds: number;
}

export class CapacityRepository {
  constructor(private readonly pool: Pool) {}

  async recordSignal(signal: CapacitySignal): Promise<void> {
    if (!(signal.at instanceof Date) || !Number.isFinite(signal.at.getTime()))
      throw new Error('Capacity signal must have a valid timestamp');
    await this.pool.query(
      `INSERT INTO ovo_capacity_signal_latest(service_key, signal, signal_at, published_at)
       VALUES ('workers', $1::jsonb, $2::timestamptz, now())
       ON CONFLICT (service_key) DO UPDATE SET
         signal = EXCLUDED.signal, signal_at = EXCLUDED.signal_at,
         published_at = EXCLUDED.published_at
       WHERE ovo_capacity_signal_latest.signal_at < EXCLUDED.signal_at`,
      [JSON.stringify({ ...signal, at: signal.at.toISOString() }), signal.at],
    );
  }

  async claimInboundFloorToken(input: {
    workerId: string;
    organizationId: string;
    ownershipEpoch: number;
    floor: number;
    leaseMs: number;
  }): Promise<boolean> {
    if (
      !input.workerId ||
      !input.organizationId ||
      !Number.isSafeInteger(input.ownershipEpoch) ||
      !Number.isSafeInteger(input.floor) ||
      input.floor < 0 ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1
    )
      throw new Error('Invalid inbound floor token claim');
    if (input.floor === 0) return false;
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-inbound-floor:${input.organizationId}`,
      ]);
      const own = await client.query<{
        ownership_epoch: string;
        token: boolean;
        lease_expires_at: Date;
        token_organization_id: string | null;
      }>(
        `SELECT ownership_epoch, metadata->>'inboundFloorToken' = 'true' AS token,
           metadata->>'inboundFloorOrganizationId' AS token_organization_id,
           lease_expires_at FROM ovo_worker_slots WHERE worker_id = $1 FOR UPDATE`,
        [input.workerId],
      );
      const previous = own.rows[0];
      if (previous && Number(previous.ownership_epoch) > input.ownershipEpoch) return false;
      const hasToken =
        previous?.token &&
        previous.lease_expires_at.getTime() > Date.now() &&
        previous.token_organization_id === input.organizationId &&
        Number(previous.ownership_epoch) === input.ownershipEpoch;
      if (!hasToken) {
        const occupied = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ovo_worker_slots
           WHERE lease_expires_at > now() AND metadata->>'inboundFloorToken' = 'true'
             AND metadata->>'inboundFloorOrganizationId' = $1 AND worker_id <> $2`,
          [input.organizationId, input.workerId],
        );
        if (Number(occupied.rows[0]?.count ?? 0) >= input.floor) return false;
      }
      const result = await client.query(
        `INSERT INTO ovo_worker_slots
           (worker_id, state, ownership_epoch, observed_at, lease_expires_at, metadata)
         VALUES ($1, 'ready_idle', $2, now(), now() + ($3 * interval '1 millisecond'),
           jsonb_build_object('inboundFloorToken', true, 'inboundFloorOrganizationId', $4::text))
         ON CONFLICT (worker_id) DO UPDATE SET
           ownership_epoch = EXCLUDED.ownership_epoch,
           lease_expires_at = EXCLUDED.lease_expires_at,
           metadata = ovo_worker_slots.metadata || EXCLUDED.metadata
         WHERE ovo_worker_slots.ownership_epoch <= EXCLUDED.ownership_epoch`,
        [input.workerId, input.ownershipEpoch, input.leaseMs, input.organizationId],
      );
      return result.rowCount === 1;
    });
  }

  async releaseInboundFloorToken(workerId: string, ownershipEpoch: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_worker_slots
       SET metadata = metadata - 'inboundFloorToken' - 'inboundFloorOrganizationId'
       WHERE worker_id = $1 AND ownership_epoch = $2`,
      [workerId, ownershipEpoch],
    );
    return result.rowCount === 1;
  }

  async reportWorker(input: WorkerReport): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO ovo_worker_slots (worker_id, state, ownership_epoch, observed_at, lease_expires_at, metadata)
       VALUES ($1, $2, $3, now(), now() + ($4 * interval '1 millisecond'), $5::jsonb)
       ON CONFLICT (worker_id) DO UPDATE SET
         -- OBS-8: an idle report does not undo the reservation inbound admission made for a route
         -- the worker has not opened yet, or one it is resuming (handshake still open or claimed).
         state = CASE WHEN EXCLUDED.state = 'ready_idle' AND EXISTS (
             SELECT 1 FROM ovo_session_routes r
             WHERE r.worker_id = EXCLUDED.worker_id
               AND r.worker_slot_epoch = EXCLUDED.ownership_epoch
               AND r.dial_request_id LIKE 'inbound:%'
               AND r.terminal_at IS NULL AND r.released_at IS NULL AND r.status <> 'terminating'
               AND (r.handshake_claimed_at IS NOT NULL OR r.handshake_expires_at > now()))
           THEN 'reserved' ELSE EXCLUDED.state END,
         ownership_epoch = EXCLUDED.ownership_epoch,
         observed_at = EXCLUDED.observed_at, lease_expires_at = EXCLUDED.lease_expires_at,
         metadata = EXCLUDED.metadata || CASE
           WHEN ovo_worker_slots.ownership_epoch = EXCLUDED.ownership_epoch
             AND ovo_worker_slots.lease_expires_at > now()
             AND ovo_worker_slots.metadata->>'inboundFloorToken' = 'true'
           THEN jsonb_build_object('inboundFloorToken', true,
             'inboundFloorOrganizationId', ovo_worker_slots.metadata->>'inboundFloorOrganizationId')
           ELSE '{}'::jsonb END
       WHERE ovo_worker_slots.ownership_epoch <= EXCLUDED.ownership_epoch`,
      [
        input.workerId,
        input.state,
        input.ownershipEpoch,
        input.leaseMs,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rowCount === 1;
  }

  async readSnapshot(): Promise<CapacitySnapshot> {
    const [workers, jobs, clock] = await Promise.all([
      this.pool.query<{ state: string; count: string; observed_at: Date }>(
        `SELECT state, count(*)::text AS count, min(observed_at) AS observed_at
         FROM ovo_worker_slots WHERE lease_expires_at > now() GROUP BY state`,
      ),
      this.pool.query<{ count: string; oldest_age: string | null }>(
        `SELECT count(*)::text AS count,
          extract(epoch FROM (now()-min(created_at)))::text AS oldest_age
         FROM ovo_jobs WHERE status = 'queued' AND not_before <= now()`,
      ),
      this.pool.query<{ now: Date }>('SELECT now() AS now'),
    ]);
    const counts = { readyIdle: 0, reserved: 0, active: 0, starting: 0, draining: 0, total: 0 };
    const stateKey = {
      ready_idle: 'readyIdle',
      reserved: 'reserved',
      active: 'active',
      starting: 'starting',
      draining: 'draining',
    } as const;
    let observedAtMs = clock.rows[0]!.now.getTime();
    for (const row of workers.rows) {
      const key = stateKey[row.state as keyof typeof stateKey];
      if (!key) continue;
      counts[key] = Number(row.count);
      counts.total += Number(row.count);
      observedAtMs = Math.min(observedAtMs, row.observed_at.getTime());
    }
    return {
      counts,
      observedAtMs,
      eligibleUnclaimed: Number(jobs.rows[0]?.count ?? 0),
      oldestEligibleJobAgeSeconds: Math.ceil(Math.max(0, Number(jobs.rows[0]?.oldest_age ?? 0))),
    };
  }
}
