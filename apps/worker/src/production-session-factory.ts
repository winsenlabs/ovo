import {
  MULAW_8K,
  outcomeFor,
  sameFormat,
  type AudioFormat,
  type EndReason,
  type InferenceUsageEvidence,
} from '@winsendotai/ovo-contracts';
import { asEndReason } from '@winsendotai/ovo-plugin-kit';
import type { ProviderUsage } from './cost-policy-types.ts';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import type { VoiceSessionFactory } from './media-runtime.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import { startEarlyCallWork, type EarlyCallWork } from './session-early-start.ts';
import type { WorkerTelemetryRuntime } from './telemetry-runtime.ts';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';
import { SessionCleanupStack, throwFailure } from './session-lifecycle.ts';
import { prepareSessionRecording } from './session-recording.ts';
import { optionalPayloadString, requiredPayloadString } from './production-session-support.ts';
import {
  composeLiveSessionGraph,
  subscribeEngineTelemetry,
  type LiveGraphOptions,
} from './session-graph-runtime.ts';
import { composeLegacySessionGraph } from './legacy-session-compat.ts';
import { auditGuardrail, closeSessionEvents, openSessionEvents } from './session-outcomes.ts';
import { optOutRecorder } from './opt-out-dnc.ts';
import {
  answeringMachineFor,
  AnsweredByVerdicts,
  watchAnsweredBy,
  type AnsweredByWatch,
} from './answering-machine.ts';

export class ProductionVoiceSessionFactory implements VoiceSessionFactory {
  constructor(
    private readonly store: ControlStore,
    private readonly secrets: SecretManager,
    private readonly telemetry: WorkerTelemetryRuntime,
    private readonly costUsageForJob?: (
      jobId: string,
    ) => ((event: ProviderUsage) => void) | undefined,
    private readonly inferenceUsageForJob?: (
      jobId: string,
    ) => ((evidence: InferenceUsageEvidence) => void) | undefined,
    private readonly extensions: InstalledSessionExtensions = { plugins: [], nativeHandlers: {} },
    private readonly recordings?: LiveRecordingService,
    private readonly recordingRetentionDays = 30,
    private readonly speechCache?: WorkerSpeechCacheRuntime,
    private readonly graph?: LiveGraphOptions,
    private readonly beforeEngineMediaClose?: (
      job: DurableJob,
      route: SessionRoute,
      reason: EndReason,
    ) => Promise<void>,
    /** Where the carrier's answering-machine callback is recorded, read for outbound calls. */
    private readonly answeredBy?: Pick<AnsweredByWatch, 'pool'>,
  ) {}

  async create(input: Parameters<VoiceSessionFactory['create']>[0]) {
    const { job, media } = input;
    const releaseId = requiredPayloadString(job.payload, 'releaseId');
    const release = await this.store.getRelease(job.workspaceId, releaseId);
    if (!release) throw new Error('immutable release not found');
    const early = startEarlyCallWork({
      ...{ job, media, release, graph: this.graph, speechCache: this.speechCache },
      ...{ extensions: this.extensions, secrets: this.secrets },
      usage: (meter) => this.costUsageForJob?.(job.id)?.(meter),
    });
    try {
      return await this.createSession(input, early);
    } catch (error) {
      await early.abandon();
      throw error;
    }
  }

  private async createSession(
    { job, route, media }: Parameters<VoiceSessionFactory['create']>[0],
    early: EarlyCallWork,
  ) {
    const { release, variables, format, callClips, sttPreconnect } = early;
    const callId = optionalPayloadString(job.payload, 'callId') ?? job.id;
    const existingCall = await this.store.getCall(job.workspaceId, callId);
    const call =
      existingCall ??
      (await this.store.createCall({
        id: callId,
        workspaceId: job.workspaceId,
        releaseId: release.id,
        kind: 'live',
        status: 'active',
      }));
    if (call.releaseId !== release.id || call.kind !== 'live')
      throw new Error('live call audit record does not match release');
    const inference = release.providerBindings.inference;
    const telemetry = await this.telemetry.createSession({
      workspaceId: job.workspaceId,
      callId,
      agentId: release.agentId,
      releaseId: release.id,
      language: release.config.language,
      inferenceProvider: inference?.provider,
      inferenceModel:
        typeof inference?.config.model === 'string' ? inference.config.model : undefined,
    });
    const cleanup = new SessionCleanupStack();
    let requestedReason: EndReason = 'error:session_setup_failed';
    cleanup.defer((failure) =>
      telemetry.close(failure === undefined ? requestedReason : 'error:session_cleanup_failed'),
    );
    if (sttPreconnect)
      cleanup.defer(async () => {
        await sttPreconnect.dispose();
        telemetry.audit('stt.preconnect', sttPreconnect.summary());
      });
    try {
      const recording = await prepareSessionRecording({
        enabled: release.config.recording,
        service: this.recordings,
        media,
        workspaceId: job.workspaceId,
        callId,
        retentionDays: release.config.recordingRetentionDays ?? this.recordingRetentionDays,
        audit: (type, payload) => telemetry.audit(type, payload),
      });
      cleanup.defer(() => recording.finish());

      if (this.graph) {
        if (!this.graph.carriers)
          throw new Error('Selected carrier runtime is required for live graph');
        const carrier = await this.graph.carriers.forJob(job, false);
        if (route.carrierId && route.carrierId !== carrier.carrier.carrierId)
          throw new Error('Session route carrier differs from selected carrier');
        if (!format || typeof format !== 'object')
          throw new Error('Worker media format is missing');
        if (
          !carrier.carrier.capabilities.media.formats.some((supported) =>
            sameFormat(supported, format),
          )
        )
          throw new Error('Selected carrier does not support negotiated worker media format');
        const events = openSessionEvents(
          this.graph.outcomes,
          { workspaceId: job.workspaceId, callId },
          telemetry,
        );
        // Deferred first, so it runs last: after the engine, and every event it records, is gone.
        if (events) cleanup.defer(() => closeSessionEvents(events, requestedReason));
        const amd = answeringMachineFor(release.config, job.payload, carrier.carrier.capabilities);
        const verdicts = amd ? new AnsweredByVerdicts() : undefined;
        if (amd && verdicts) {
          const unsubscribe =
            media.onAnsweredBy?.((value) => verdicts.deliver(value)) ?? (() => undefined);
          cleanup.defer(() => unsubscribe());
          if (this.answeredBy) {
            const stop = watchAnsweredBy({
              pool: this.answeredBy.pool,
              route,
              deliver: (value) => verdicts.deliver(value),
              fastForMs: amd.timeoutMs,
            });
            cleanup.defer(() => stop());
          }
        }
        const graph = await composeLiveSessionGraph({
          graph: this.graph,
          release,
          routeSessionId: route.sessionId,
          variables,
          media: recording.media,
          operationStore: telemetry.withOperationStore(this.store.operationStore),
          secrets: this.secrets.forAgent(release.agentId),
          telemetry,
          extensions: this.extensions,
          usage: (meter) => this.costUsageForJob?.(job.id)?.(meter),
          speechCache: this.speechCache,
          callClips,
          sttPreconnect,
          carrierMedia: {
            carrierId: carrier.carrier.carrierId,
            format,
            playbackEvidence: carrier.carrier.capabilities.media.playbackEvidence,
            clearFlushesMarkers: carrier.carrier.capabilities.media.clearFlushesMarkers,
          },
          beforeMediaClose: this.beforeEngineMediaClose
            ? (reason) => this.beforeEngineMediaClose!(job, route, reason)
            : undefined,
          ...(amd && verdicts
            ? { amd, answeredBy: (listener) => verdicts.subscribe(listener) }
            : {}),
          ...(events ? { events } : {}),
        });
        cleanup.defer(() => graph.composition.dispose());
        if (callClips) cleanup.defer(() => this.speechCache?.perCall.release(job.id));
        cleanup.defer(() => auditGuardrail(graph.composition, telemetry));
        cleanup.defer(optOutRecorder(this.graph, graph, job, telemetry));
        const unsubscribe = subscribeEngineTelemetry(graph.engine, telemetry);
        cleanup.defer(() => unsubscribe());
        cleanup.defer(recording.attachEvidence(graph.engine));
        cleanup.defer(async () => {
          await graph.engine.dispose(requestedReason);
        });
        await graph.engine.start();
        return {
          dispose: async (reason?: string) => {
            const endReason = asEndReason(reason ?? 'behavior_completed');
            recordSessionOutcome(telemetry, endReason);
            requestedReason = endReason;
            const failure = await cleanup.close();
            if (failure !== undefined) throwFailure(failure);
          },
        };
      }

      const legacy = await composeLegacySessionGraph({
        job,
        route,
        release,
        media: recording.media,
        telemetry,
        store: this.store,
        extensions: this.extensions,
      });
      cleanup.defer(() => legacy.composition.dispose());
      cleanup.defer(async () => {
        await legacy.engine.dispose(requestedReason);
      });
      return {
        dispose: async (reason?: string) => {
          const endReason = asEndReason(reason ?? 'behavior_completed');
          recordSessionOutcome(telemetry, endReason);
          requestedReason = endReason;
          const failure = await cleanup.close();
          if (failure !== undefined) throwFailure(failure);
        },
      };
    } catch (error) {
      const failure = await cleanup.close(error);
      throwFailure(failure);
    }
  }
}

export function recordSessionOutcome(
  telemetry: Pick<WorkerSessionTelemetry, 'audit'>,
  reason: EndReason,
): 'ended' | 'failed' {
  const outcome = outcomeFor(reason);
  telemetry.audit('session.outcome', { outcome, reason });
  return outcome === 'failed' || outcome === 'canceled' ? 'failed' : 'ended';
}
