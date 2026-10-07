import type { InfrastructureService } from './infrastructure-types.ts';
import type { WorkerLiveState } from './inbound-readiness.ts';

/** The infrastructure service with the worker live-state reader the live-path diagnostic uses. */
export type LivePathInfrastructure = InfrastructureService & {
  workerLiveState?(): Promise<WorkerLiveState[]>;
};

/** A provider pre-warm older than this no longer says anything about reachability. */
const PROVIDER_EVIDENCE_MAX_AGE_MS = 15 * 60_000;
/** A session-open failure this recent is still news. */
const OPEN_FAILURE_WINDOW_MS = 10 * 60_000;
/** A queued job older than this means no worker is taking work. */
const QUEUE_STALL_MS = 60_000;

type Provider = {
  origin: string;
  slots?: string[];
  ok: boolean;
  status?: number;
  elapsedMs?: number;
  error?: string;
  checkedAt?: string;
};

/**
 * One synthetic answer to "can a call go live right now?" (OBS-12): the database, live
 * installation, worker capacity, queue, inbound readiness, and what workers last saw of their
 * STT/TTS/LLM/decision providers (cached pre-warm results, never a new provider request) and of
 * their own session opens. Each problem becomes a blocker naming its stage.
 */
export async function liveDiagnostics(
  infrastructure: LivePathInfrastructure | undefined,
  workspaceId: string,
  now = Date.now(),
) {
  const blockers: string[] = [];
  if (!infrastructure)
    return { ready: false, blockers: ['infrastructure: readiness service is not configured'] };
  // Worker and inbound state is installation-wide: only the installation's own workspace may
  // read it, exactly as InfrastructureService.snapshot refuses every other organization.
  if (infrastructure.organizationId !== workspaceId)
    throw Object.assign(new Error('Live-path diagnostics are not available for this workspace'), {
      statusCode: 404,
      code: 'not_found',
    });
  const started = Date.now();
  let snapshot: Awaited<ReturnType<InfrastructureService['snapshot']>> | undefined;
  let databaseError: string | undefined;
  try {
    snapshot = await infrastructure.snapshot(workspaceId);
  } catch (error) {
    // An HTTP-shaped error (404 not_found and the like) is a refusal, not a database outage.
    if (typeof (error as { statusCode?: unknown })?.statusCode === 'number') throw error;
    databaseError = error instanceof Error ? error.message.slice(0, 200) : 'unavailable';
    blockers.push(`database: ${databaseError}`);
  }
  const database = { ok: !databaseError, latencyMs: Date.now() - started, error: databaseError };
  const [inbound, workers] = await Promise.all([
    infrastructure.inboundReadiness?.().catch(() => null) ?? null,
    infrastructure.workerLiveState?.().catch(() => []) ?? [],
  ]);
  if (snapshot) {
    if (snapshot.installation.status !== 'ready')
      blockers.push(...snapshot.installation.reasons.map((reason) => `installation: ${reason}`));
    if (!snapshot.workers.ready && !snapshot.workers.reserved && !snapshot.workers.active)
      blockers.push('workers: no worker has a fresh heartbeat');
    else if (!snapshot.workers.ready) blockers.push('workers: no idle worker can take a call');
    if ((snapshot.queue.oldestAgeMs ?? 0) > QUEUE_STALL_MS)
      blockers.push(`queue: oldest job waited ${Math.round(snapshot.queue.oldestAgeMs! / 1000)} s`);
  }
  if (inbound?.admissionEnabled && (!inbound.ready || inbound.stale))
    blockers.push(
      `inbound: ${inbound.stale ? 'dispatcher readiness is stale' : inbound.reasons.join('; ') || 'not ready'}`,
    );
  const providers = new Map<string, Provider & { workerId: string }>();
  const openFailures: { workerId: string; stage: string; reason: string; at: string }[] = [];
  for (const worker of workers) {
    for (const provider of (worker.live?.providers as Provider[] | undefined) ?? []) {
      const age = provider.checkedAt ? now - Date.parse(provider.checkedAt) : Infinity;
      const known = providers.get(provider.origin);
      if (age > PROVIDER_EVIDENCE_MAX_AGE_MS) continue;
      if (!known || (known.checkedAt ?? '') < (provider.checkedAt ?? ''))
        providers.set(provider.origin, { ...provider, workerId: worker.workerId });
    }
    const failure = worker.live?.lastSessionOpenFailure as
      { stage: string; reason: string; at: string } | null | undefined;
    // Named fields only: the published failure also carries the session id, which stays private.
    if (failure && now - Date.parse(failure.at) <= OPEN_FAILURE_WINDOW_MS)
      openFailures.push({
        workerId: worker.workerId,
        stage: failure.stage,
        reason: failure.reason,
        at: failure.at,
      });
  }
  for (const provider of providers.values())
    if (!provider.ok)
      blockers.push(
        `provider ${provider.slots?.join('/') || provider.origin}: ${provider.error ?? `HTTP ${provider.status ?? 'error'}`}`,
      );
  for (const failure of openFailures)
    blockers.push(`session open (${failure.stage}) on ${failure.workerId}: ${failure.reason}`);
  return {
    ready: blockers.length === 0,
    blockers,
    generatedAt: new Date(now).toISOString(),
    database,
    installation: snapshot?.installation ?? null,
    workers: snapshot?.workers ?? null,
    queue: snapshot?.queue ?? null,
    inbound,
    providers: [...providers.values()],
    recentSessionOpenFailures: openFailures,
    workerHealth: workers.map((worker) => ({
      workerId: worker.workerId,
      state: worker.state,
      observedAt: worker.observedAt,
      handshakeMs: worker.live?.handshakeMs ?? null,
      timeouts: worker.live?.timeouts ?? {},
      callEvents: worker.live?.callEvents ?? null,
    })),
  };
}
