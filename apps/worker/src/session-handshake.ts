import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  BeginDialSessionInput,
  ClaimedJob,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';

export interface SessionHandshake {
  token: string;
  route: BeginDialSessionInput;
}

export function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
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
