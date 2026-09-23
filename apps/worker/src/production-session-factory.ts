import {
  MULAW_8K,
  outcomeFor,
  sameFormat,
  type EndReason,
  type InferenceUsageEvidence,
} from '@winsendotai/ovo-contracts';
import { asEndReason } from '@winsendotai/ovo-plugin-kit';
import type { ProviderUsage } from './cost-policy-types.ts';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import type { VoiceSessionFactory } from './media-runtime.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
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
import { attachRecordingEvidence } from './recording-evidence.ts';

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
  ) {}

  async create({ job, route, media }: Parameters<VoiceSessionFactory['create']>[0]) {
    const releaseId = requiredPayloadString(job.payload, 'releaseId');
    const callId = optionalPayloadString(job.payload, 'callId') ?? job.id;
    const release = await this.store.getRelease(job.workspaceId, releaseId);
    if (!release) throw new Error('immutable release not found');
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
    let requestedOutcome: 'ended' | 'failed' = 'failed';
    let requestedReason: string | undefined = 'session setup failed';
    cleanup.defer((failure) =>
      telemetry.close(
        failure === undefined ? requestedOutcome : 'failed',
        failure === undefined ? requestedReason : 'session cleanup failed',
      ),
    );
    try {
      const recording = await prepareSessionRecording({
        enabled: release.config.recording,
        service: this.recordings,
        media,
        workspaceId: job.workspaceId,
        callId,
        retentionDays: this.recordingRetentionDays,
      });
      const capture = recording.capture;
      if (capture) cleanup.defer(() => capture.finish());

      if (this.graph) {
        if (!this.graph.carriers)
          throw new Error('Selected carrier runtime is required for live graph');
        const carrier = await this.graph.carriers.forJob(job, false);
        if (route.carrierId && route.carrierId !== carrier.carrier.carrierId)
          throw new Error('Session route carrier differs from selected carrier');
        if (
          !carrier.carrier.capabilities.media.formats.some((format) => sameFormat(format, MULAW_8K))
        )
          throw new Error('Legacy worker media requires a carrier supporting MULAW_8K');
        const graph = await composeLiveSessionGraph({
          graph: this.graph,
          release,
          routeSessionId: route.sessionId,
          variables: isPayloadRecord(job.payload.variables) ? job.payload.variables : {},
          media: recording.media,
          operationStore: telemetry.withOperationStore(this.store.operationStore),
          secrets: this.secrets.forAgent(release.agentId),
          telemetry,
          extensions: this.extensions,
          usage: (meter) => this.costUsageForJob?.(job.id)?.(meter),
          speechCache: this.speechCache,
          carrierMedia: {
            carrierId: carrier.carrier.carrierId,
            playbackEvidence: carrier.carrier.capabilities.media.playbackEvidence,
            clearFlushesMarkers: carrier.carrier.capabilities.media.clearFlushesMarkers,
          },
        });
        cleanup.defer(() => graph.composition.dispose());
        const unsubscribe = subscribeEngineTelemetry(graph.engine, telemetry);
        cleanup.defer(() => unsubscribe());
        if (capture) cleanup.defer(attachRecordingEvidence(capture, graph.engine));
        cleanup.defer(async () => {
          await graph.engine.dispose(asEndReason(requestedReason ?? 'drain'));
        });
        await graph.engine.start();
        return {
          dispose: async (reason?: string) => {
            const endReason = asEndReason(reason ?? 'behavior_completed');
            requestedOutcome = recordSessionOutcome(telemetry, endReason);
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
          requestedOutcome = recordSessionOutcome(telemetry, endReason);
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

function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
