import { filterDeclaredVariables, type EndReason } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { CallScope, SessionDeps } from './call-scope.ts';
import { composeCallSegment, type CallSegment, type SegmentInput } from './call-segment.ts';
import { SegmentReleaseMissingError, type SegmentTarget } from './call-segments.ts';
import { handoffMediaClose } from './router-graph.ts';
import { routeEventSink } from './routing-events.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import type { SegmentGraphShape } from './segment-ids.ts';
import type { LiveGraphOptions } from './session-graph-runtime.ts';
import { startEarlyCallWork } from './session-early-start.ts';
import type { AttemptTarget } from './transfer-attempt.ts';

export type LiveSessionDeps = SessionDeps & { graph: LiveGraphOptions };

/** The call's time limit is the router policy's; a later segment gets what is left of it. */
export function routedCallSeconds(routerRelease: ReleaseRecord): number {
  return routerRelease.config.costPolicy?.maxCallSeconds ?? 1800;
}

/** What a routed call adds to every segment it composes. */
export interface SegmentHooks {
  /** The call is handing on: no segment's hang-up or carrier transfer runs (transfer design 7.1). */
  handingOff(): boolean;
  /** R2: a transfer's per-segment additions (sink, telemetry, usage, services, shape). */
  decorate?(
    input: SegmentInput,
    context: { index: number; target: SegmentTarget | AttemptTarget; lease: SegmentMediaLease },
  ): SegmentInput;
}

/**
 * Composes one agent segment of a routed call on `lease` (routing design 7.4), not started:
 *
 * - its early work (STT pre-connect, per-call clips) runs under `<job id>:s<index>`, and the
 *   segment disposes its own STT;
 * - its variables are the call's, the values the call captured (R2), and the route's
 *   `ovo_route_*` context, as far as its release's variables schema declares and accepts them (a
 *   strict agent refuses any other);
 * - from segment 1 its ids carry `s<index>:` and its time limit is what is left of the router
 *   policy's;
 * - it hangs up, or hands the carrier leg on, with its own release's transfer target (never while
 *   the call is handing on), and its callbacks dial its own release.
 *
 * Segment 0 of a degraded call (the default target, the router unavailable) is composed the same
 * way under the job id itself, with its own limit and unprefixed ids.
 */
export function routedSegmentComposer(
  deps: LiveSessionDeps,
  scope: CallScope,
  routerRelease: ReleaseRecord,
  hooks?: SegmentHooks,
): (
  target: SegmentTarget | AttemptTarget,
  index: number,
  lease: SegmentMediaLease,
) => Promise<CallSegment> {
  const { job, route } = scope;
  return async (target, index, lease) => {
    const release = await deps.store.getRelease(job.workspaceId, target.releaseId);
    if (!release) throw new SegmentReleaseMissingError(target.releaseId);
    const callKey = index === 0 ? job.id : `${job.id}:s${index}`;
    const raw = job.payload.variables;
    const own = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const captured = 'captured' in target ? target.captured : undefined;
    const variables = filterDeclaredVariables(release.config, {
      ...own,
      ...captured,
      ...target.variables,
    });
    // The transfer target and the call's own variables read the segment's release from here.
    const payload = { ...job.payload, releaseId: release.id, variables };
    const early = startEarlyCallWork({
      ...{ job: { id: callKey, payload }, media: scope.link, release, graph: deps.graph },
      ...{ speechCache: deps.speechCache, extensions: deps.extensions, secrets: deps.secrets },
      usage: (meter) => deps.costUsageForJob?.(job.id)?.(meter),
    });
    const close = deps.beforeEngineMediaClose;
    const shape: SegmentGraphShape | undefined =
      index === 0
        ? undefined
        : {
            idPrefix: `s${index}:`,
            maxCallSeconds:
              routedCallSeconds(routerRelease) - Math.floor((Date.now() - scope.openedAt) / 1000),
          };
    const input: SegmentInput = {
      ...{ release, variables: early.variables, callKey, callClips: early.callClips },
      ...{ sttPreconnect: early.sttPreconnect, ownsStt: true, media: lease },
      events: routeEventSink(scope.events, { releaseId: release.id, telemetry: scope.telemetry }),
      beforeMediaClose: close
        ? handoffMediaClose(hooks?.handingOff ?? (() => false), (reason: EndReason) =>
            close({ ...job, payload }, route, reason),
          )
        : undefined,
      ...(shape ? { shape } : {}),
    };
    try {
      return await composeCallSegment(
        deps,
        scope,
        hooks?.decorate?.(input, { index, target, lease }) ?? input,
      );
    } catch (error) {
      await early.abandon();
      throw error;
    }
  };
}
