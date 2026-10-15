import type { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { openCallScope, type CallScope, type SessionOpenInput } from './call-scope.ts';
import { composeCallSegment, type SegmentInput } from './call-segment.ts';
import { CallSegmentController } from './call-segments.ts';
import type { ManagedVoiceSession } from './media-runtime.ts';
import { ProductionVoiceSessionFactory } from './production-session-factory.ts';
import { requiredPayloadString } from './production-session-support.ts';
import {
  DegradedRoute,
  degradedTranscriptText,
  endRoutedCall,
  loadSnapshot,
  releaseClaims,
  routedJob,
  routingHost,
  type RoutedJob,
  type RoutingRuntimeOptions,
} from './routed-call-support.ts';
import { routedSegmentComposer, type LiveSessionDeps } from './routed-segments.ts';
import { handoffMediaClose, routerSegmentShape } from './router-graph.ts';
import { transferControl } from './routed-transfer.ts';
import { TransferController } from './transfer-controller.ts';
import { routedAgentIds, routeEventSink } from './routing-events.ts';
import { startEarlyCallWork, type EarlyCallWork } from './session-early-start.ts';

export {
  ROUTING_SNAPSHOT_TIMEOUT_MS,
  routedJob,
  type RoutedJob,
  type RoutingRuntimeOptions,
} from './routed-call-support.ts';

const log = createLogger({ service: 'worker' });

/**
 * The production factory, for routed calls too (routing design 7.2). A job without
 * `payload.routing` takes the production path unchanged. A routed job opens one call scope with
 * the router release and runs segment 0, the router, on a lease of the call's media; the router
 * hands the call to its chosen agent through the call's CallSegmentController. When the routing
 * release cannot be read in time, or the router cannot be composed, the call degrades: the
 * routing release's default target answers as segment 0, and the decision says so.
 */
export class RoutedVoiceSessionFactory extends ProductionVoiceSessionFactory {
  private routing?: RoutingRuntimeOptions;

  /** Turns routed calls on; without it every job takes the production path. */
  route(options: RoutingRuntimeOptions): this {
    this.routing = options;
    return this;
  }

  override async create(input: SessionOpenInput): Promise<ManagedVoiceSession> {
    const routing = routedJob(input.job.payload);
    const { graph } = this.deps;
    if (!routing || !this.routing || !graph) return super.create(input);
    return openRoutedCall({ ...this.deps, graph }, this.routing, input, routing);
  }
}

async function openRoutedCall(
  deps: LiveSessionDeps,
  options: RoutingRuntimeOptions,
  input: SessionOpenInput,
  routing: RoutedJob,
): Promise<ManagedVoiceSession> {
  const { job, media } = input;
  const releaseId = requiredPayloadString(job.payload, 'releaseId');
  const routerRelease = await deps.store.getRelease(job.workspaceId, releaseId);
  if (!routerRelease) throw new Error('immutable release not found');
  let early: EarlyCallWork | undefined = startEarlyCallWork({
    ...{ job, media, release: routerRelease, graph: deps.graph, speechCache: deps.speechCache },
    ...{ extensions: deps.extensions, secrets: deps.secrets },
    usage: (meter) => deps.costUsageForJob?.(job.id)?.(meter),
  });
  try {
    const snapshot = await loadSnapshot(options, routing, releaseId);
    const scope = await openCallScope(deps, input, {
      release: routerRelease,
      format: early.format,
      transcriptText: snapshot
        ? deps.telemetry.strictestTranscriptText(routedAgentIds(snapshot))
        : await degradedTranscriptText(deps, job.workspaceId, routerRelease, routing),
    });
    return await runRoutedCall(deps, options, scope, routerRelease, routing, snapshot, () => {
      const taken = early;
      early = undefined;
      return taken;
    });
  } catch (error) {
    await early?.abandon();
    throw error;
  }
}

async function runRoutedCall(
  deps: LiveSessionDeps,
  options: RoutingRuntimeOptions,
  scope: CallScope,
  routerRelease: ReleaseRecord,
  routing: RoutedJob,
  snapshot: RoutingReleaseSnapshot | undefined,
  takeEarly: () => EarlyCallWork | undefined,
): Promise<ManagedVoiceSession> {
  const { job, telemetry } = scope;
  const session = { dispose: (reason?: string) => scope.dispose(reason) };
  const claims = options.routing?.claims;
  const call = { jobId: job.id, sessionId: scope.route.sessionId };
  // Deferred first, so it runs after every segment is gone: the call's member claim is released.
  scope.cleanup.defer(() => releaseClaims(claims, job.id, telemetry));
  const workerEvents = routeEventSink(scope.events, {
    releaseId: routerRelease.id,
    telemetry,
    call,
  });
  const record = (type: string, payload: Record<string, unknown>) =>
    void workerEvents.append(type, payload);
  const early = snapshot ? takeEarly() : undefined;
  // In-call transfers (R2) need the routing snapshot; off, or without one, the call is R1's.
  const transfers =
    options.transferEnabled && snapshot && early
      ? transferControl(deps, options, scope, routerRelease, routing, snapshot, early.variables)
      : undefined;
  const compose =
    transfers?.compose ??
    routedSegmentComposer(deps, scope, routerRelease, { handingOff: () => controller.handingOff });
  const controller: CallSegmentController | TransferController =
    transfers?.controller ??
    new CallSegmentController({
      media: scope.media,
      format: scope.carrierMedia!.format,
      allowed: new Set(snapshot?.releaseIds ?? []),
      fallback: snapshot
        ? {
            agentId: snapshot.defaultTarget.agentId,
            releaseId: snapshot.defaultTarget.release.releaseId,
          }
        : { agentId: '', releaseId: routing.defaultReleaseId },
      compose,
      record,
      audit: (type, payload) => telemetry.audit(type, payload),
      releaseClaim: () => releaseClaims(claims, job.id, telemetry),
      endCall: (reason) => endRoutedCall(deps, scope, reason),
      prepareTimeoutMs: options.prepareTimeoutMs,
    });
  scope.cleanup.defer(() => controller.close(scope.reason));
  try {
    if (!snapshot || !early) throw new DegradedRoute('snapshot_unavailable');
    const lease = controller.lease(true);
    const router: SegmentInput = {
      ...{ release: routerRelease, variables: early.variables, callKey: job.id },
      ...{ callClips: early.callClips, sttPreconnect: early.sttPreconnect, ownsStt: true },
      media: lease,
      events: routeEventSink(scope.events, {
        releaseId: snapshot.defaultTarget.release.releaseId,
        telemetry,
        call,
      }),
      beforeMediaClose: handoffMediaClose(
        () => controller.handingOff,
        deps.beforeEngineMediaClose &&
          ((reason) => deps.beforeEngineMediaClose!(job, scope.route, reason)),
      ),
      shape: routerSegmentShape({
        ...{ behavior: options.routerBehavior(), routerRelease, snapshot },
        host: routingHost(deps, options, scope, routerRelease, routing, early.variables),
        sessionId: scope.route.sessionId,
        handoff: controller,
      }),
    };
    const segment = await composeCallSegment(
      deps,
      scope,
      transfers ? transfers.decorate(router, 0) : router,
    ).catch(async () => {
      await early.abandon();
      lease.release();
      throw new DegradedRoute('router_compose_failed');
    });
    controller.attach(segment, lease);
    record('route.segment', {
      ...{ index: 0, role: 'router', reason: 'start' },
      ...{ agentId: routerRelease.agentId, releaseId: routerRelease.id },
    });
    await segment.start();
    return session;
  } catch (error) {
    if (!(error instanceof DegradedRoute)) return scope.fail(error);
    await takeEarly()?.abandon();
    log.warn('route_degraded', {
      jobId: job.id,
      sessionId: scope.route.sessionId,
      reason: error.reason,
    });
    telemetry.audit('route.degraded', { reason: error.reason });
    try {
      const target = { agentId: '', releaseId: routing.defaultReleaseId, variables: {} };
      const lease = controller.lease(true);
      const segment = await compose(target, 0, lease).catch((failure: unknown) => {
        lease.release();
        throw failure;
      });
      if (controller instanceof TransferController)
        controller.attach(segment, lease, { role: 'agent' });
      else controller.attach(segment, lease);
      const agent = { agentId: segment.release.agentId, releaseId: segment.release.id };
      record('route.decision', {
        ...{ routingPointId: routing.routingPointId, routingReleaseId: routing.routingReleaseId },
        ...{ path: [], target: 'agent', ...agent, turns: 0, routeMs: 0, degraded: error.reason },
      });
      record('route.segment', { index: 0, role: 'agent', ...agent, reason: 'degraded' });
      await segment.start();
      return session;
    } catch (failure) {
      return scope.fail(failure);
    }
  }
}
