import type {
  EndReason,
  EventSink,
  VoiceMediaTransport,
  VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { Composition } from '@winsendotai/ovo-runtime';
import { sttDisposal, type CallScope, type SessionDeps } from './call-scope.ts';
import { optOutRecorder } from './opt-out-dnc.ts';
import {
  composeLiveSessionGraph,
  subscribeEngineTelemetry,
  type LiveGraphOptions,
  type SegmentGraphShape,
} from './session-graph-runtime.ts';
import { SessionCleanupStack } from './session-lifecycle.ts';
import { auditGuardrail } from './session-outcomes.ts';
import type { SttPreconnect } from './session-stt-preconnect.ts';
import type { CallClips } from './speech-cache-percall.ts';

/** One engine graph of a call: what it runs, and on which media. */
export interface SegmentInput {
  release: ReleaseRecord;
  variables: Readonly<Record<string, unknown>>;
  /** The key its per-call clips are held under: the job id, or `<job id>:s<index>`. */
  callKey: string;
  callClips?: CallClips;
  sttPreconnect?: SttPreconnect;
  /** The segment disposes its early STT itself (a routed call's); otherwise the call scope does. */
  ownsStt?: boolean;
  /** Defaults to the call's media. */
  media?: VoiceMediaTransport;
  /** Defaults to the call's outcome events. */
  events?: EventSink;
  beforeMediaClose?: (reason: EndReason) => Promise<void>;
  shape?: SegmentGraphShape;
}

export interface CallSegment {
  readonly release: ReleaseRecord;
  readonly engine: VoiceSessionEngine;
  readonly composition: Composition;
  start(): Promise<void>;
  /** Disposes the engine, then everything composed for it; resolves the first failure. */
  close(reason: EndReason): Promise<unknown | undefined>;
}

/**
 * Composes one segment's graph on the call's scope without starting it, with its own cleanup
 * stack. A composition that fails releases what it took and rethrows.
 */
export async function composeCallSegment(
  deps: SessionDeps & { graph: LiveGraphOptions },
  scope: CallScope,
  input: SegmentInput,
): Promise<CallSegment> {
  const { job, telemetry } = scope;
  const { release, callClips, sttPreconnect } = input;
  const cleanup = new SessionCleanupStack();
  let reason: EndReason = 'error:session_setup_failed';
  if (sttPreconnect && input.ownsStt) cleanup.defer(sttDisposal(sttPreconnect, telemetry));
  try {
    if (!scope.carrierMedia) throw new Error('call scope has no live carrier leg');
    const events = input.events ?? scope.events;
    const graph = await composeLiveSessionGraph({
      graph: deps.graph,
      release,
      routeSessionId: scope.route.sessionId,
      variables: input.variables,
      media: input.media ?? scope.media,
      operationStore: telemetry.withOperationStore(deps.store.operationStore),
      secrets: deps.secrets.forAgent(release.agentId),
      telemetry,
      extensions: deps.extensions,
      usage: (meter) => deps.costUsageForJob?.(job.id)?.(meter),
      speechCache: deps.speechCache,
      callClips,
      sttPreconnect,
      carrierMedia: scope.carrierMedia,
      beforeMediaClose: input.beforeMediaClose,
      ...(scope.amd && scope.answeredBy ? { amd: scope.amd, answeredBy: scope.answeredBy } : {}),
      ...(events ? { events } : {}),
      ...(input.shape ? { segment: input.shape } : {}),
    });
    cleanup.defer(() => graph.composition.dispose());
    if (callClips) cleanup.defer(() => deps.speechCache?.perCall.release(input.callKey));
    cleanup.defer(() => auditGuardrail(graph.composition, telemetry));
    cleanup.defer(optOutRecorder(deps.graph, graph, job, telemetry));
    const unsubscribe = subscribeEngineTelemetry(graph.engine, telemetry);
    cleanup.defer(() => unsubscribe());
    cleanup.defer(scope.recording.attachEvidence(graph.engine));
    cleanup.defer(async () => {
      await graph.engine.dispose(reason);
    });
    return {
      release,
      engine: graph.engine,
      composition: graph.composition,
      start: () => graph.engine.start(),
      close: (endReason) => {
        reason = endReason;
        return cleanup.close();
      },
    };
  } catch (error) {
    throw (await cleanup.close(error)) ?? error;
  }
}
