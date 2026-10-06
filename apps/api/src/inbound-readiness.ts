import type { Pool } from 'pg';

/** What the dispatcher last reported about inbound go-live (`apps/dispatcher` InboundReadiness). */
export interface InboundReadinessReport {
  admissionEnabled: boolean;
  readyWorkers: number;
  readyProtected: number;
  warmFloor: number;
  ready: boolean;
  reasons: string[];
  observedAt: string;
  ageMs: number;
  /** Older than the capacity-signal age limit: the dispatcher is not running or not publishing. */
  stale: boolean;
}

/**
 * OPS-4: readiness was only on the dispatcher's own /health, so the console could not say why
 * `readyProtected` was 0. The dispatcher now publishes it under service_key 'inbound-readiness'.
 */
export async function readInboundReadiness(
  pool: Pick<Pool, 'query'>,
  maxAgeMs: number,
): Promise<InboundReadinessReport | null> {
  const result = await pool.query<{
    signal: Record<string, unknown>;
    signal_at: Date;
    age_ms: string;
  }>(
    `SELECT signal, signal_at, extract(epoch FROM (now() - signal_at))*1000 AS age_ms
       FROM ovo_capacity_signal_latest WHERE service_key = 'inbound-readiness'`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const signal = row.signal;
  const ageMs = Math.max(0, Math.round(Number(row.age_ms)));
  return {
    admissionEnabled: signal.admissionEnabled === true,
    readyWorkers: Number(signal.readyWorkers ?? 0),
    readyProtected: Number(signal.readyProtected ?? 0),
    warmFloor: Number(signal.warmFloor ?? 0),
    ready: signal.ready === true,
    reasons: Array.isArray(signal.reasons) ? signal.reasons.map(String) : [],
    observedAt: new Date(row.signal_at).toISOString(),
    ageMs,
    stale: ageMs > maxAgeMs,
  };
}

/** What one worker last published about its live path (OBS-12, the worker's verbose health). */
export interface WorkerLiveState {
  workerId: string;
  state: string;
  observedAt: string;
  live: Record<string, unknown> | null;
}

/** Every worker with a fresh heartbeat and the live-path state its report carried, newest first. */
export async function readWorkerLiveState(
  pool: Pick<Pool, 'query'>,
  heartbeatMaxAgeMs: number,
  limit = 50,
): Promise<WorkerLiveState[]> {
  const result = await pool.query<{
    worker_id: string;
    state: string;
    observed_at: Date;
    live: Record<string, unknown> | null;
  }>(
    `SELECT worker_id, state, observed_at, metadata->'live' AS live FROM ovo_worker_slots
     WHERE lease_expires_at > now() AND observed_at >= now() - ($1 * interval '1 millisecond')
     ORDER BY observed_at DESC, worker_id LIMIT $2`,
    [heartbeatMaxAgeMs, limit],
  );
  return result.rows.map((row) => ({
    workerId: row.worker_id,
    state: row.state,
    observedAt: new Date(row.observed_at).toISOString(),
    live: row.live && typeof row.live === 'object' ? row.live : null,
  }));
}
