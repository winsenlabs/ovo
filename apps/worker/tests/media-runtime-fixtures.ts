import { MULAW_8K } from '@winsendotai/ovo-contracts';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';

export function mediaRuntimeFixture() {
  const route: SessionRoute = {
    sessionId: 'session-1',
    jobId: 'job-1',
    organizationId: 'workspace-1',
    workerId: 'worker-1',
    workerEndpoint: 'ws://worker-1/internal/media',
    ownerEpoch: 7,
    generation: 2,
    dialRequestId: 'job-1:7',
    carrierId: 'twilio',
    bindingId: 'env',
    carrierCallId: 'CA1',
    status: 'accepted',
    handshakeExpiresAt: new Date(Date.now() + 60_000),
  };
  const job: DurableJob = {
    id: route.jobId,
    workspaceId: route.organizationId,
    idempotencyKey: 'job-1',
    payload: {},
    status: 'accepted',
    ownerId: route.workerId,
    ownerEpoch: route.ownerEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  return { route, job };
}

export function mediaSessionOpen(route: SessionRoute, routeToken = 'token') {
  if (!route.carrierCallId) throw new Error('fixture route has no carrier call ID');
  return {
    type: 'session.open',
    protocol: 2,
    sessionId: route.sessionId,
    carrierId: route.carrierId ?? 'twilio',
    bindingId: route.bindingId ?? 'env',
    carrierCallId: route.carrierCallId,
    streamId: 'MZ1',
    ownerEpoch: route.ownerEpoch,
    generation: route.generation,
    format: MULAW_8K,
    playbackEvidence: 'carrier-played',
    clearFlushesMarkers: true,
    routeToken,
  } as const;
}
