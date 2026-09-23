import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PostgresOrchestrationStore } from '../src/postgres.ts';

export async function beginRoute(store: PostgresOrchestrationStore, schema: string, label: string) {
  const jobId = randomUUID();
  await store.enqueue({ id: jobId, workspaceId: schema, idempotencyKey: label, payload: {} });
  const claimed = await store.claim(jobId, 'carrier-worker', 60_000);
  if (claimed.kind !== 'execute') throw new Error('expected claimed job');
  const dialRequestId = `${label}:${jobId}`;
  const token = `initial-${randomUUID()}`;
  const route = await store.beginDialSession({
    sessionId: randomUUID(),
    jobId,
    organizationId: schema,
    workerId: claimed.job.ownerId,
    workerEndpoint: 'ws://127.0.0.1/internal/media',
    ownerEpoch: claimed.job.ownerEpoch,
    generation: 1,
    dialRequestId,
    carrierId: 'carrier-test',
    bindingId: 'binding-test',
    carrierRequestId: `request-${label}`,
    handshakeTokenHash: createHash('sha256').update(token).digest('hex'),
    handshakeExpiresAt: new Date(Date.now() + 60_000),
  });
  if (!route) throw new Error('expected route');
  return { route, jobId, owner: claimed.job, token };
}

export async function waitForBlockedStore(admin: Pool, schema: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await admin.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
       WHERE application_name = $1 AND wait_event_type = 'Lock') AS blocked`,
      [schema],
    );
    if (activity.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('store did not reach the expected PostgreSQL lock wait');
}
