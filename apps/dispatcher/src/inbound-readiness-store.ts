import type { InboundReadiness } from './dispatcher-capacity.ts';

/** The row key the API reads for `GET /v1/operations/inbound/capacity` (OPS-4). */
export const INBOUND_READINESS_KEY = 'inbound-readiness';

interface Queryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Persists the dispatcher's latest inbound readiness next to the worker capacity signal, so the
 * API and console can show why `readyProtected` is 0 without reaching the dispatcher's /health.
 */
export async function publishInboundReadiness(
  pool: Queryable,
  readiness: InboundReadiness,
  at: Date = new Date(),
): Promise<void> {
  await pool.query(
    `INSERT INTO ovo_capacity_signal_latest(service_key, signal, signal_at, published_at)
     VALUES ($1, $2::jsonb, $3::timestamptz, now())
     ON CONFLICT (service_key) DO UPDATE SET
       signal = EXCLUDED.signal, signal_at = EXCLUDED.signal_at, published_at = EXCLUDED.published_at
     WHERE ovo_capacity_signal_latest.signal_at <= EXCLUDED.signal_at`,
    [INBOUND_READINESS_KEY, JSON.stringify(readiness), at],
  );
}
