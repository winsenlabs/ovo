import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BeginDialSessionInput, ClaimedJob } from '@winsendotai/ovo-plugin-orchestration';

export interface SessionHandshake {
  token: string;
  route: BeginDialSessionInput;
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
