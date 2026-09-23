import type { PoolClient } from 'pg';

/** Serialize all uses of one carrier call id across primary and stream-alias columns. */
export async function lockCarrierCallId(client: PoolClient, callId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`carrier-call-id:${callId}`]);
}

export async function callIdAvailable(
  client: PoolClient,
  jobId: string,
  callId: string,
): Promise<boolean> {
  const collision = await client.query(
    `SELECT 1 FROM ovo_session_routes WHERE job_id <> $1
       AND (carrier_call_id = $2 OR carrier_stream_call_id = $2) LIMIT 1`,
    [jobId, callId],
  );
  return collision.rowCount === 0;
}
