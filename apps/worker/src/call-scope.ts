import {
  outcomeFor,
  sameFormat,
  type AudioFormat,
  type EndReason,
  type MediaDuplex,
} from '@winsendotai/ovo-contracts';
import { asEndReason } from '@winsendotai/ovo-plugin-kit';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { QueuedSessionEventSink } from '@winsendotai/ovo-plugin-storage/outcomes';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import {
  answeringMachineFor,
  AnsweredByVerdicts,
  watchAnsweredBy,
  type AnsweredByWatch,
} from './answering-machine.ts';
import type { ProviderUsage } from './cost-policy-types.ts';
import type { VoiceSessionFactory } from './media-runtime.ts';
import { optionalPayloadString } from './production-session-support.ts';
import { closeSessionEvents, openSessionEvents } from './session-outcomes.ts';
import type { LiveCarrierMedia, LiveGraphOptions } from './session-graph-runtime.ts';
import { SessionCleanupStack, throwFailure } from './session-lifecycle.ts';
import { prepareSessionRecording, type SessionRecording } from './session-recording.ts';
import type { SttPreconnect } from './session-stt-preconnect.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import type {
  TranscriptText,
  WorkerSessionTelemetry,
  WorkerTelemetryRuntime,
} from './telemetry-runtime.ts';

/** What a live call's sessions are built from: the production factory's constructor arguments. */
export interface SessionDeps {
  store: ControlStore;
  secrets: SecretManager;
  telemetry: WorkerTelemetryRuntime;
  costUsageForJob?: (jobId: string) => ((event: ProviderUsage) => void) | undefined;
  extensions: InstalledSessionExtensions;
  recordings?: LiveRecordingService;
  recordingRetentionDays: number;
  speechCache?: WorkerSpeechCacheRuntime;
  graph?: LiveGraphOptions;
  beforeEngineMediaClose?: (
    job: DurableJob,
    route: SessionRoute,
    reason: EndReason,
  ) => Promise<void>;
  answeredBy?: Pick<AnsweredByWatch, 'pool'>;
}

export type SessionOpenInput = Parameters<VoiceSessionFactory['create']>[0];

/**
 * What a call holds once, whatever runs on it: the call record, its telemetry session, its
 * recording, its outcome events and the selected carrier leg. A routed call runs several engine
 * graphs (segments) inside one scope; any other call runs exactly one.
 */
export class CallScope {
  readonly cleanup = new SessionCleanupStack();
  /** How the call is ending; cleanups read it as they run. */
  reason: EndReason = 'error:session_setup_failed';
  recording!: SessionRecording;
  events?: QueuedSessionEventSink;
  carrierMedia?: LiveCarrierMedia;
  amd?: { timeoutMs: number };
  answeredBy?: NonNullable<MediaDuplex['onAnsweredBy']>;
  readonly openedAt = Date.now();

  constructor(
    readonly job: DurableJob,
    readonly route: SessionRoute,
    /** The call's media link itself, under any recording. */
    readonly link: SessionOpenInput['media'],
    readonly callId: string,
    readonly release: ReleaseRecord,
    readonly telemetry: WorkerSessionTelemetry,
  ) {}

  /** The call's media, through its recording when it is recorded. */
  get media(): SessionRecording['media'] {
    return this.recording.media;
  }

  /** Ends the call: records how, then releases everything in reverse order. */
  async dispose(reason?: string): Promise<void> {
    const endReason = asEndReason(reason ?? 'behavior_completed');
    recordSessionOutcome(this.telemetry, endReason);
    this.reason = endReason;
    const failure = await this.cleanup.close();
    if (failure !== undefined) throwFailure(failure);
  }

  /** Closes what is open after a failed setup and rethrows the first failure. */
  async fail(error: unknown): Promise<never> {
    throwFailure(await this.cleanup.close(error));
  }
}

/** Opens the call's scope for `release`, the release its call record must hold. */
export async function openCallScope(
  deps: SessionDeps,
  { job, route, media }: SessionOpenInput,
  first: {
    release: ReleaseRecord;
    format: AudioFormat;
    /** Disposed with the call; a routed call disposes each segment's STT with the segment. */
    sttPreconnect?: SttPreconnect;
    transcriptText?: TranscriptText;
  },
): Promise<CallScope> {
  const { release, format, sttPreconnect } = first;
  const callId = optionalPayloadString(job.payload, 'callId') ?? job.id;
  const existingCall = await deps.store.getCall(job.workspaceId, callId);
  const call =
    existingCall ??
    (await deps.store.createCall({
      id: callId,
      workspaceId: job.workspaceId,
      releaseId: release.id,
      kind: 'live',
      status: 'active',
    }));
  if (call.releaseId !== release.id || call.kind !== 'live')
    throw new Error('live call audit record does not match release');
  const inference = release.providerBindings.inference;
  const telemetry = await deps.telemetry.createSession({
    workspaceId: job.workspaceId,
    callId,
    agentId: release.agentId,
    releaseId: release.id,
    language: release.config.language,
    inferenceProvider: inference?.provider,
    inferenceModel:
      typeof inference?.config.model === 'string' ? inference.config.model : undefined,
    mediaFormat: format,
    ...(first.transcriptText ? { transcriptText: first.transcriptText } : {}),
  });
  const scope = new CallScope(job, route, media, callId, release, telemetry);
  const { cleanup } = scope;
  cleanup.defer((failure) =>
    telemetry.close(failure === undefined ? scope.reason : 'error:session_cleanup_failed'),
  );
  if (sttPreconnect) cleanup.defer(sttDisposal(sttPreconnect, telemetry));
  try {
    const recording = await prepareSessionRecording({
      enabled: release.config.recording,
      service: deps.recordings,
      media,
      workspaceId: job.workspaceId,
      callId,
      retentionDays: release.config.recordingRetentionDays ?? deps.recordingRetentionDays,
      audit: (type, payload) => telemetry.audit(type, payload),
    });
    scope.recording = recording;
    cleanup.defer(() => recording.finish());
    if (deps.graph) await openLiveLeg(deps, deps.graph, scope, format);
    return scope;
  } catch (error) {
    return scope.fail(error);
  }
}

/** The carrier leg, outcome events and answering-machine watch a live graph needs. */
async function openLiveLeg(
  deps: SessionDeps,
  graph: LiveGraphOptions,
  scope: CallScope,
  format: AudioFormat,
): Promise<void> {
  const { job, route, release, telemetry, cleanup } = scope;
  if (!graph.carriers) throw new Error('Selected carrier runtime is required for live graph');
  const carrier = await graph.carriers.forJob(job, false);
  if (route.carrierId && route.carrierId !== carrier.carrier.carrierId)
    throw new Error('Session route carrier differs from selected carrier');
  if (!format || typeof format !== 'object') throw new Error('Worker media format is missing');
  if (
    !carrier.carrier.capabilities.media.formats.some((supported) => sameFormat(supported, format))
  )
    throw new Error('Selected carrier does not support negotiated worker media format');
  const events = openSessionEvents(
    graph.outcomes,
    { workspaceId: job.workspaceId, callId: scope.callId },
    telemetry,
  );
  // Deferred first, so it runs last: after the engine, and every event it records, is gone.
  if (events) cleanup.defer(() => closeSessionEvents(events, scope.reason));
  scope.events = events;
  const amd = answeringMachineFor(release.config, job.payload, carrier.carrier.capabilities);
  const verdicts = amd ? new AnsweredByVerdicts() : undefined;
  if (amd && verdicts) {
    const unsubscribe =
      scope.link.onAnsweredBy?.((value) => verdicts.deliver(value)) ?? (() => undefined);
    cleanup.defer(() => unsubscribe());
    if (deps.answeredBy) {
      const stop = watchAnsweredBy({
        pool: deps.answeredBy.pool,
        route,
        deliver: (value) => verdicts.deliver(value),
        fastForMs: amd.timeoutMs,
      });
      cleanup.defer(() => stop());
    }
    scope.amd = amd;
    scope.answeredBy = (listener) => verdicts.subscribe(listener);
  }
  scope.carrierMedia = {
    carrierId: carrier.carrier.carrierId,
    format,
    playbackEvidence: carrier.carrier.capabilities.media.playbackEvidence,
    clearFlushesMarkers: carrier.carrier.capabilities.media.clearFlushesMarkers,
  };
}

/** Disposes an STT session opened ahead of its engine and audits what the early start did. */
export function sttDisposal(stt: SttPreconnect, telemetry: Pick<WorkerSessionTelemetry, 'audit'>) {
  return async () => {
    await stt.dispose();
    telemetry.audit('stt.preconnect', stt.summary());
  };
}

export function recordSessionOutcome(
  telemetry: Pick<WorkerSessionTelemetry, 'audit'>,
  reason: EndReason,
): 'ended' | 'failed' {
  const outcome = outcomeFor(reason);
  telemetry.audit('session.outcome', { outcome, reason });
  return outcome === 'failed' || outcome === 'canceled' ? 'failed' : 'ended';
}
