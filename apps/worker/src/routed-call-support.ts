import { RouteUuid, type EndReason, type RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import {
  OPERATIONS_SERVICE_KEY,
  type OperationsService,
  type RoutingService,
} from '@winsendotai/ovo-plugin-operations';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import type { CallScope } from './call-scope.ts';
import type { LiveGraphOptions } from './session-graph-runtime.ts';
import { routedCallSeconds, type LiveSessionDeps } from './routed-segments.ts';
import { createRoutingHost } from './routing-host.ts';

const log = createLogger({ service: 'worker' });

/** How long a routed call waits for its routing release before it degrades (design 7.2). */
export const ROUTING_SNAPSHOT_TIMEOUT_MS = 1_000;

/** What admission wrote on a routed job (`payload.routing`, design 7.1). */
export interface RoutedJob {
  routingReleaseId: string;
  routingPointId: string;
  version: number;
  defaultReleaseId: string;
}

export interface RoutingRuntimeOptions {
  /** `operations.routing`; absent when operations is not composed (every routed call degrades). */
  routing?: Pick<RoutingService, 'releases' | 'claims'>;
  /** The router behaviour plugin (`@winsendotai/ovo-plugin-router`). */
  routerBehavior: () => PluginDefinition;
  /** `OVO_ROUTING_EXTERNAL_ENABLED`. */
  externalEnabled: boolean;
  /** `OVO_ROUTING_PREPARE_TIMEOUT_MS`. */
  prepareTimeoutMs?: number;
  snapshotTimeoutMs?: number;
}

/** The job's routing, when admission routed it; anything malformed is not a routed job. */
export function routedJob(payload: Record<string, unknown>): RoutedJob | undefined {
  const routing = payload.routing as Partial<RoutedJob> | null | undefined;
  if (!routing || typeof routing !== 'object') return undefined;
  const { routingReleaseId, routingPointId, version, defaultReleaseId } = routing;
  if (
    !RouteUuid.safeParse(routingReleaseId).success ||
    !RouteUuid.safeParse(routingPointId).success ||
    !RouteUuid.safeParse(defaultReleaseId).success ||
    typeof version !== 'number'
  )
    return undefined;
  return { routingReleaseId, routingPointId, version, defaultReleaseId } as RoutedJob;
}

export function routingHost(
  deps: LiveSessionDeps,
  options: RoutingRuntimeOptions,
  scope: CallScope,
  routerRelease: ReleaseRecord,
  routing: RoutedJob,
  variables: Readonly<Record<string, unknown>>,
) {
  const { job, telemetry } = scope;
  const claims = options.routing?.claims;
  return createRoutingHost({
    call: {
      callId: scope.callId,
      workspaceId: job.workspaceId,
      routingPointId: routing.routingPointId,
      routingReleaseId: routing.routingReleaseId,
      ...callerNumbers(job.payload),
      variables,
    },
    jobId: job.id,
    maxCallSeconds: routedCallSeconds(routerRelease),
    ...(claims ? { claims } : {}),
    external: {
      enabled: options.externalEnabled,
      workspaceId: job.workspaceId,
      secrets: deps.secrets.forAgent(routerRelease.agentId),
    },
    audit: (type, payload) => telemetry.audit(type, payload),
  });
}

/**
 * The routing release the job names, read within the bound; undefined (the call degrades) when
 * it cannot be read in time, is missing, or does not name the job's release as its router.
 */
export async function loadSnapshot(
  options: RoutingRuntimeOptions,
  routing: RoutedJob,
  routerReleaseId: string,
): Promise<RoutingReleaseSnapshot | undefined> {
  const releases = options.routing?.releases;
  if (!releases) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    const ms = options.snapshotTimeoutMs ?? ROUTING_SNAPSHOT_TIMEOUT_MS;
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    const release = await Promise.race([
      releases.get(routing.routingReleaseId).catch(() => undefined),
      expired,
    ]);
    const snapshot = release?.snapshot;
    if (
      !snapshot ||
      release.routingPointId !== routing.routingPointId ||
      snapshot.router.release.releaseId !== routerReleaseId
    )
      return undefined;
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

export async function releaseClaims(
  claims: Pick<RoutingService['claims'], 'release'> | undefined,
  jobId: string,
  telemetry: CallScope['telemetry'],
): Promise<void> {
  try {
    await claims?.release(jobId);
  } catch {
    // swallow-ok: an unreleased claim lapses at its expiry (design 5.1); the call ends regardless.
    telemetry.audit('route.claims.unavailable', {});
  }
}

/** No engine is left to end the call (a failed handoff): hang up, then close the link. */
export async function endRoutedCall(
  deps: LiveSessionDeps,
  scope: CallScope,
  reason: EndReason,
): Promise<void> {
  log.warn('route_handoff_failed', {
    jobId: scope.job.id,
    sessionId: scope.route.sessionId,
    reason,
  });
  try {
    await deps.beforeEngineMediaClose?.(scope.job, scope.route, reason);
  } finally {
    await scope.media.close(reason);
  }
}

function callerNumbers(payload: Record<string, unknown>): { from?: string; to?: string } {
  return {
    ...(typeof payload.from === 'string' ? { from: payload.from } : {}),
    ...(typeof payload.to === 'string' ? { to: payload.to } : {}),
  };
}

/** The process's operations service, which holds routing storage; absent in a slim composition. */
export function operationsOf(graph: LiveGraphOptions | undefined): OperationsService | undefined {
  try {
    return graph?.parent.ctx.get(OPERATIONS_SERVICE_KEY) as OperationsService | undefined;
  } catch {
    return undefined;
  }
}
