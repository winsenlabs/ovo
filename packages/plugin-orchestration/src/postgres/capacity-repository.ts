import type { Pool } from 'pg';

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
}

export class CapacityRepository {
  constructor(private readonly pool: Pool) {}

  async reportWorker(input: WorkerReport): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO ovo_worker_slots (worker_id, state, ownership_epoch, observed_at, lease_expires_at, metadata)
       VALUES ($1, $2, $3, now(), now() + ($4 * interval '1 millisecond'), $5::jsonb)
       ON CONFLICT (worker_id) DO UPDATE SET
         state = EXCLUDED.state, ownership_epoch = EXCLUDED.ownership_epoch,
         observed_at = EXCLUDED.observed_at, lease_expires_at = EXCLUDED.lease_expires_at, metadata = EXCLUDED.metadata
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
        `SELECT state, count(*)::text AS count, max(observed_at) AS observed_at
         FROM ovo_worker_slots WHERE lease_expires_at > now() GROUP BY state`,
      ),
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ovo_jobs WHERE status = 'queued' AND not_before <= now()`,
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
    return { counts, observedAtMs, eligibleUnclaimed: Number(jobs.rows[0]?.count ?? 0) };
  }
}
