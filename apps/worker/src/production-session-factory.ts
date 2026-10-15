import type { EndReason, InferenceUsageEvidence } from '@winsendotai/ovo-contracts';
import type { ProviderUsage } from './cost-policy-types.ts';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import type { ManagedVoiceSession, VoiceSessionFactory } from './media-runtime.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import { startEarlyCallWork, type EarlyCallWork } from './session-early-start.ts';
import type { WorkerTelemetryRuntime } from './telemetry-runtime.ts';
import { requiredPayloadString } from './production-session-support.ts';
import type { LiveGraphOptions } from './session-graph-runtime.ts';
import { composeLegacySessionGraph } from './legacy-session-compat.ts';
import type { AnsweredByWatch } from './answering-machine.ts';
import {
  openCallScope,
  type CallScope,
  type SessionDeps,
  type SessionOpenInput,
} from './call-scope.ts';
import { composeCallSegment, type CallSegment } from './call-segment.ts';

export { recordSessionOutcome } from './call-scope.ts';

export class ProductionVoiceSessionFactory implements VoiceSessionFactory {
  /** The constructor's arguments by name: what a routed call opens its scope and segments from. */
  protected readonly deps: SessionDeps;

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
  ) {
    this.deps = {
      ...{ store, secrets, telemetry, costUsageForJob, extensions, recordings },
      ...{ recordingRetentionDays, speechCache, graph, beforeEngineMediaClose, answeredBy },
    };
  }

  async create(input: SessionOpenInput): Promise<ManagedVoiceSession> {
    const { job, media } = input;
    const { store, graph, speechCache, extensions, secrets } = this.deps;
    const releaseId = requiredPayloadString(job.payload, 'releaseId');
    const release = await store.getRelease(job.workspaceId, releaseId);
    if (!release) throw new Error('immutable release not found');
    const early = startEarlyCallWork({
      ...{ job, media, release, graph, speechCache, extensions, secrets },
      usage: (meter) => this.deps.costUsageForJob?.(job.id)?.(meter),
    });
    try {
      return await this.createSession(input, early);
    } catch (error) {
      await early.abandon();
      throw error;
    }
  }

  private async createSession(input: SessionOpenInput, early: EarlyCallWork) {
    const { job, route } = input;
    const { release, variables, format, callClips, sttPreconnect } = early;
    const scope = await openCallScope(this.deps, input, { release, format, sttPreconnect });
    try {
      const { graph, beforeEngineMediaClose } = this.deps;
      if (graph) {
        const segment = await composeCallSegment({ ...this.deps, graph }, scope, {
          ...{ release, variables, callKey: job.id, callClips, sttPreconnect },
          beforeMediaClose: beforeEngineMediaClose
            ? (reason) => beforeEngineMediaClose(job, route, reason)
            : undefined,
        });
        scopeOwns(scope, segment);
        await segment.start();
        return { dispose: (reason?: string) => scope.dispose(reason) };
      }
      const legacy = await composeLegacySessionGraph({
        ...{ job, route, release, media: scope.media, telemetry: scope.telemetry },
        ...{ store: this.deps.store, extensions: this.deps.extensions },
      });
      scope.cleanup.defer(() => legacy.composition.dispose());
      scope.cleanup.defer(async () => {
        await legacy.engine.dispose(scope.reason);
      });
      return { dispose: (reason?: string) => scope.dispose(reason) };
    } catch (error) {
      return scope.fail(error);
    }
  }
}

/** The call disposes the segment, with the call's ending, before anything else it holds. */
export function scopeOwns(scope: CallScope, segment: Pick<CallSegment, 'close'>): void {
  scope.cleanup.defer(async () => {
    const failure = await segment.close(scope.reason);
    if (failure !== undefined) throw failure;
  });
}
