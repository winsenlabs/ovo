import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  BeginDialSessionInput,
  ClaimedJob,
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { GatewayToWorkerMessage } from '@winsendotai/ovo-plugin-media';

type Open = Extract<GatewayToWorkerMessage, { type: 'session.open' }>;

export interface RouteTokenStore extends DurableJobStore {
  pool?: {
    query<T extends object>(
      sql: string,
      values: unknown[],
    ): Promise<{ rows: T[]; rowCount?: number | null }>;
  };
}

export interface SessionHandshake {
  token: string;
  route: BeginDialSessionInput;
}

export function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Admit only a claimed route whose job, slot, epoch, binding and call still match. */
export async function authenticatedMediaRoute(
  store: RouteTokenStore,
  workerId: string,
  open: Open,
): Promise<SessionRoute> {
  if (!store.pool) throw new Error('durable route token store is unavailable');
  const claim = await store.pool.query<{
    job_id: string;
    organization_id: string;
    carrier_id: string;
    handshake_token_hash: string;
    handshake_claimed_at: Date | null;
    worker_slot_epoch: string | null;
    dial_request_id: string | null;
  }>(
    `SELECT job_id, organization_id, carrier_id, handshake_token_hash,
            handshake_claimed_at, worker_slot_epoch, dial_request_id
     FROM ovo_session_routes WHERE session_id = $1`,
    [open.sessionId],
  );
  const row = claim.rows[0];
  const actualHash = createHash('sha256').update(open.routeToken, 'utf8').digest('hex');
  if (!row?.handshake_claimed_at || !sameHash(row.handshake_token_hash, actualHash))
    throw new Error('media route token was not claimed');
  const route = await store.resolveSessionRoute({
    organizationId: row.organization_id,
    carrierId: row.carrier_id,
    sessionId: open.sessionId,
    carrierCallId: open.carrierCallId,
  });
  if (
    !route ||
    route.sessionId !== open.sessionId ||
    route.jobId !== row.job_id ||
    route.workerId !== workerId ||
    route.ownerEpoch !== open.ownerEpoch ||
    route.generation !== open.generation ||
    route.carrierId !== open.carrierId ||
    row.carrier_id !== open.carrierId ||
    (route.bindingId ?? 'env') !== open.bindingId ||
    (route.carrierCallId !== open.carrierCallId &&
      route.carrierStreamCallId !== open.carrierCallId) ||
    route.terminalAt ||
    route.releasedAt ||
    route.status === 'terminating'
  )
    throw new Error('media route does not match the active owner');
  const slot = await store.pool.query<{ ownership_epoch: string }>(
    `SELECT ownership_epoch FROM ovo_worker_slots
     WHERE worker_id = $1 AND lease_expires_at > now()
       AND (state IN ('reserved', 'active') OR (state = 'ready_idle' AND $2))`,
    // Inbound routes are fenced by the inbound capacity reservation (see sessions.ts authenticate).
    [route.workerId, row.dial_request_id?.startsWith('inbound:') ?? false],
  );
  if (!row.worker_slot_epoch || slot.rows[0]?.ownership_epoch !== row.worker_slot_epoch)
    throw new Error('worker slot lease no longer owns the media route');
  await activelyOwnedMediaJob(store, route);
  return route;
}

export async function activelyOwnedMediaJob(
  store: DurableJobStore,
  route: SessionRoute,
): Promise<DurableJob> {
  const job = await store.get(route.jobId);
  if (
    !job ||
    job.ownerId !== route.workerId ||
    job.ownerEpoch !== route.ownerEpoch ||
    !job.leaseExpiresAt ||
    job.leaseExpiresAt.getTime() <= Date.now() ||
    !['dialing', 'reconcile_required', 'accepted', 'connected'].includes(job.status)
  )
    throw new Error('durable job is not actively owned by the routed worker');
  return job;
}

export function createSessionHandshake(input: {
  job: ClaimedJob;
  workerEndpoint: string;
  ttlMs?: number;
  ringTimeoutSec?: number;
}): SessionHandshake {
  const ttlMs =
    input.ringTimeoutSec === undefined
      ? (input.ttlMs ?? 120_000)
      : (input.ringTimeoutSec + 60) * 1_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
    throw new Error('Handshake TTL must be a positive integer');
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    route: {
      sessionId: randomUUID(),
      jobId: input.job.id,
      organizationId: input.job.workspaceId,
      workerId: input.job.ownerId,
      workerEndpoint: input.workerEndpoint,
      ownerEpoch: input.job.ownerEpoch,
      generation: 1,
      dialRequestId: `${input.job.id}:${input.job.ownerEpoch}`,
      handshakeTokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      handshakeExpiresAt: new Date(Date.now() + ttlMs),
    },
  };
}

/** A claimed token or early worker accept is not evidence that an engine opened. */
export async function recordSessionOpened(
  pool: { query(sql: string, values: unknown[]): Promise<{ rowCount?: number | null }> },
  route: SessionRoute,
): Promise<void> {
  const written = await pool.query(
    `INSERT INTO ovo_carrier_callbacks (
       provider, event_id, session_id, dial_request_id, carrier_call_id,
       status, occurred_at, payload, organization_id, carrier_id
     )
     SELECT 'ovo.media', 'media.opened:' || r.session_id, r.session_id,
            r.dial_request_id, r.carrier_call_id, 'session_opened', now(), '{}'::jsonb,
            r.organization_id, r.carrier_id
     FROM ovo_session_routes r JOIN ovo_jobs j ON j.id = r.job_id
     WHERE r.session_id = $1 AND r.organization_id = $2 AND r.carrier_id = $3
       AND r.worker_id = $4 AND r.owner_epoch = $5 AND r.generation = $6
       AND r.handshake_claimed_at IS NOT NULL AND r.terminal_at IS NULL
       AND r.released_at IS NULL AND r.status IN ('dialing', 'accepted', 'connected')
       AND j.owner_id = r.worker_id AND j.owner_epoch = r.owner_epoch
       AND j.lease_expires_at > now()
       AND j.status IN ('dialing', 'reconcile_required', 'accepted', 'connected')
     ON CONFLICT DO NOTHING`,
    [
      route.sessionId,
      route.organizationId,
      route.carrierId,
      route.workerId,
      route.ownerEpoch,
      route.generation,
    ],
  );
  if (written.rowCount !== 1) throw new Error('media session opening was not durably recorded');
}
