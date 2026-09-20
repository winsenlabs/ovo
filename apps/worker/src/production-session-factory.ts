import { liveSessionRequiresInput } from './live-input-policy.ts';
import type { OperationStore, SecretResolver } from '@winsendotai/ovo-contracts';
import {
  createSessionPluginCatalog,
  type InstalledSessionExtensions,
  type SessionPluginInput,
} from '@winsendotai/ovo-plugin-session';
import {
  createDeepgramSttPlugin,
  createOpenAiTtsPlugin,
  createStreamingSpeechOutputPlugin,
  deepgramBindingFromRecord,
  openAiTtsBindingFromRecord,
  type ProviderUsage,
} from '@winsendotai/ovo-plugin-providers';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import {
  STREAMING_VOICE_SERVICE_KEYS,
  VOICE_SERVICE_KEYS,
  type BoundedSpeechScheduler,
  createSpeechSchedulerPlugin,
  createVoiceSessionEnginePlugin,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-plugin-voice';
import { compose, definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { VoiceSessionFactory } from './media-runtime.ts';
import { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import type { SpeechCacheTelemetrySink } from '@winsendotai/ovo-plugin-speech-cache';
import type { WorkerTelemetryRuntime } from './telemetry-runtime.ts';
import { SessionCleanupStack, throwFailure } from './session-lifecycle.ts';
import { prepareSessionRecording } from './session-recording.ts';
import {
  instrumentInferencePlugin,
  instrumentSttPlugin,
  instrumentTtsPlugin,
} from './telemetry-stages.ts';
import {
  immutableMcpConnections,
  installedPluginsForRelease,
  optionalPayloadString,
  pluginConfig,
  requiredPayloadString,
  uniqueDefinitions,
  validateReleasePlugins,
} from './production-session-support.ts';

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
    ) => SessionPluginInput['onInferenceUsage'],
    private readonly extensions: InstalledSessionExtensions = { plugins: [], nativeHandlers: {} },
    private readonly recordings?: LiveRecordingService,
    private readonly recordingRetentionDays = 30,
    private readonly speechCache?: WorkerSpeechCacheRuntime,
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
    const requiresInput = liveSessionRequiresInput(release.config);
    const stt = release.providerBindings.stt;
    const tts = release.providerBindings.tts;
    if ((requiresInput && !stt) || !tts)
      throw new Error('live release is missing an immutable required voice binding');
    const mcpTools = release.config.tools.filter(
      (tool) => tool.connector === 'mcp' && release.config.allowedTools.includes(tool.id),
    );
    const mcpConnections = immutableMcpConnections(release, mcpTools);
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

      const audit = (type: string, payload: Record<string, unknown>) =>
        telemetry.audit(type, payload);
      const usage = (event: ProviderUsage) => {
        this.costUsageForJob?.(job.id)?.(event);
        telemetry.providerUsage(event);
      };
      const ttsBinding = openAiTtsBindingFromRecord(tts);
      const cacheTelemetry: SpeechCacheTelemetrySink = (event) => {
        void audit('speech.cache', event as unknown as Record<string, unknown>);
      };
      const output =
        this.speechCache?.createOutputPlugin({
          agent: release.config,
          binding: ttsBinding,
          emitCache: cacheTelemetry,
        }) ?? createStreamingSpeechOutputPlugin();
      const sessionCatalog = createSessionPluginCatalog({
        config: release.config,
        workspaceId: release.workspaceId,
        bindings: release.providerBindings,
        mcpConnections,
        nativeHandlers: this.extensions.nativeHandlers,
        nativeHandlerPackages: this.extensions.nativeHandlerPackages,
        releasePlugins: release.plugins,
        output: { kind: 'live', plugin: output },
        onInferenceUsage: (evidence) => {
          this.inferenceUsageForJob?.(job.id)?.(evidence);
          telemetry.inferenceUsage(evidence);
        },
      }).map((definition) =>
        definition.manifest.provides.includes('ovo.inference')
          ? instrumentInferencePlugin(definition, telemetry, {
              provider: inference?.provider,
              model:
                typeof inference?.config.model === 'string' ? inference.config.model : undefined,
            })
          : definition,
      );
      const installed = installedPluginsForRelease(release, this.extensions.plugins);
      validateReleasePlugins(release, [...sessionCatalog, ...installed]);

      const services = sessionServicesPlugin(
        telemetry.withOperationStore(this.store.operationStore),
        this.secrets.forAgent(release.agentId),
        recording.media,
      );
      const sttPlugin =
        stt && requiresInput
          ? instrumentSttPlugin(
              createDeepgramSttPlugin(deepgramBindingFromRecord(stt), {
                usage,
                transcript: (revision) => telemetry.transcript(revision, false),
              }),
              telemetry,
              {
                provider: stt.provider,
                model: typeof stt.config.model === 'string' ? stt.config.model : undefined,
              },
            )
          : undefined;
      const ttsPlugin = instrumentTtsPlugin(
        createOpenAiTtsPlugin(ttsBinding, { usage }),
        telemetry,
        {
          provider: tts.provider,
          model: typeof tts.config.model === 'string' ? tts.config.model : undefined,
        },
      );
      const catalog = uniqueDefinitions([
        services,
        ...sessionCatalog,
        ...installed,
        ...(sttPlugin ? [sttPlugin] : []),
        ttsPlugin,
        output,
        createSpeechSchedulerPlugin(),
        createVoiceSessionEnginePlugin({
          stt: requiresInput ? 'required' : 'disabled',
          onAcceptedTranscript: (revision) => telemetry.transcript(revision, true),
        }),
      ]);
      audit('session.driver-bound', {
        releaseId: release.id,
        sessionId: route.sessionId,
        generation: route.generation,
        media: 'live',
        sttBindingVersion: stt ? `${stt.id}:${stt.updatedAt}` : undefined,
        ttsBindingVersion: `${tts.id}:${tts.updatedAt}`,
      });
      const composition = await compose(
        catalog.map((definition) => ({
          id: definition.manifest.id,
          config: pluginConfig(definition, release, route.sessionId, job.payload),
        })),
        catalog,
      );
      cleanup.defer(() => composition.dispose());
      const engine = composition.ctx.get(
        STREAMING_VOICE_SERVICE_KEYS.sessionEngine,
      ) as VoiceSessionEngine;
      if (!engine) throw new Error('live plugin graph did not create a voice session engine');
      cleanup.defer(() => engine.dispose(requestedReason));
      const scheduler = composition.ctx.get(VOICE_SERVICE_KEYS.scheduler) as BoundedSpeechScheduler;
      if (!scheduler) throw new Error('live plugin graph did not create a speech scheduler');
      telemetry.attachScheduler(scheduler);
      recording.capture?.attachEvidence(scheduler);
      return {
        dispose: async (reason?: string) => {
          requestedOutcome =
            reason === undefined || reason === 'behavior_completed' || reason.includes('completed')
              ? 'ended'
              : 'failed';
          requestedReason = reason;
          const failure = await cleanup.close();
          if (failure !== undefined) throwFailure(failure);
        },
      } as Pick<VoiceSessionEngine, 'dispose'>;
    } catch (error) {
      const failure = await cleanup.close(error);
      throwFailure(failure);
    }
  }
}

function sessionServicesPlugin(
  operationStore: OperationStore,
  secrets: SecretResolver,
  media: unknown,
): PluginDefinition {
  return definePlugin(
    {
      id: '@winsendotai/ovo-worker/session-services',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: ['ovo.operation-store', 'ovo.secret-resolver', STREAMING_VOICE_SERVICE_KEYS.media],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide('ovo.operation-store', operationStore);
      ctx.provide('ovo.secret-resolver', {
        resolve: (workspaceId: string, credentialId: string) =>
          secrets.resolve(workspaceId, credentialId),
      } satisfies SecretResolver);
      ctx.provide(STREAMING_VOICE_SERVICE_KEYS.media, media);
    },
  );
}
