import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { OperationRecord } from '@winsendotai/ovo-contracts';
import type {
  SpeechEvidence,
  TranscriptRevision,
  VoiceProviderUsage,
} from '@winsendotai/ovo-plugin-voice';
import type { BufferedTelemetryWriter } from './telemetry-ingestion.ts';
import type { TelemetryEvent, TelemetryOutcome, TelemetrySource } from './telemetry-types.ts';

export interface WorkerTelemetryContext {
  workspaceId: string;
  callId: string;
  source: TelemetrySource;
  agentId: string;
  releaseId: string;
  language: string;
  provider?: string;
  model?: string;
  /** Seed this from the durable call cursor before accepting media after a worker restart. */
  nextSequence: () => number;
  now?: () => Date;
}

type SchedulerEvidenceSource = {
  subscribe(listener: (evidence: SpeechEvidence) => void): () => void;
};

export class WorkerTelemetryAdapter {
  private readonly now: () => Date;
  private readonly playbackStartedAt = new Map<string, number>();

  constructor(
    private readonly writer: BufferedTelemetryWriter,
    private readonly context: WorkerTelemetryContext,
  ) {
    this.now = context.now ?? (() => new Date());
  }

  sessionStarted(): boolean {
    return this.emit({ kind: 'session.started' });
  }

  sessionEnded(outcome: 'ended' | 'failed', reason?: string): boolean {
    return this.emit({
      kind: outcome === 'ended' ? 'session.ended' : 'session.failed',
      outcome: outcome === 'ended' ? 'succeeded' : 'failed',
      payload: reason ? { reason: reason.slice(0, 500) } : {},
    });
  }

  startStage(input: {
    stage: string;
    stageId?: string;
    provider?: string;
    model?: string;
    turnId?: string;
    responseEpoch?: number;
  }): (outcome?: Exclude<TelemetryOutcome, 'running'>) => boolean {
    const stageId = input.stageId ?? randomUUID();
    const started = performance.now();
    let settled = false;
    this.emit({ ...input, stageId, kind: 'stage.started', outcome: 'running' });
    return (outcome = 'succeeded') => {
      if (settled) return false;
      settled = true;
      return this.emit({
        ...input,
        stageId,
        kind:
          outcome === 'succeeded'
            ? 'stage.completed'
            : outcome === 'timeout'
              ? 'stage.timeout'
              : 'stage.failed',
        outcome,
        durationMs: Math.max(0, performance.now() - started),
      });
    };
  }

  transcript(revision: TranscriptRevision, accepted = false): boolean {
    return this.emit({
      kind: accepted ? 'transcript.accepted' : 'transcript.revision',
      payload: {
        revision: revision.revision,
        isFinal: revision.isFinal,
        speechFinal: revision.speechFinal,
        speechStarted: revision.speechStarted ?? false,
        confidence: revision.confidence ?? null,
        startMs: revision.startMs ?? null,
        durationMs: revision.durationMs ?? null,
        textLength: revision.text.length,
      },
    });
  }

  speech(evidence: SpeechEvidence): boolean {
    const accepted = this.emit({
      kind: `playback.${evidence.phase}` as TelemetryEvent['kind'],
      segmentId: evidence.segmentId,
      responseEpoch: evidence.epoch,
      evidence: evidence.evidence,
      payload: {
        speechKind: evidence.kind,
        textLength: evidence.text.length,
        reason: evidence.reason?.slice(0, 500) ?? null,
      },
    });
    const stageId = `playback:${evidence.segmentId}:${evidence.epoch}`;
    if (evidence.phase === 'started') this.playbackStartedAt.set(stageId, evidence.at);
    if (!['completed', 'interrupted', 'dropped', 'failed'].includes(evidence.phase))
      return accepted;
    const startedAt = this.playbackStartedAt.get(stageId);
    this.playbackStartedAt.delete(stageId);
    const stageAccepted = this.emit({
      kind: evidence.phase === 'completed' ? 'stage.completed' : 'stage.failed',
      stageId,
      stage: 'playback',
      responseEpoch: evidence.epoch,
      durationMs: startedAt === undefined ? undefined : Math.max(0, evidence.at - startedAt),
      outcome: evidence.phase === 'completed' ? 'succeeded' : 'failed',
      evidence: evidence.evidence,
      payload: { terminalPhase: evidence.phase },
    });
    return accepted && stageAccepted;
  }

  operation(record: OperationRecord): boolean {
    const accepted = this.emit({
      kind: `operation.${record.state}` as TelemetryEvent['kind'],
      operationId: record.id,
      outcome: operationOutcome(record.state),
      payload: { toolId: record.toolId, hasResult: record.result !== undefined },
    });
    if (record.state === 'intent' || record.state === 'running') return accepted;
    const createdAt = Date.parse(record.createdAt);
    const stageAccepted = this.emit({
      kind: record.state === 'succeeded' ? 'stage.completed' : 'stage.failed',
      stageId: `operation:${record.id}`,
      stage: 'operation',
      operationId: record.id,
      durationMs: Number.isFinite(createdAt)
        ? Math.max(0, this.now().valueOf() - createdAt)
        : undefined,
      outcome: operationOutcome(record.state),
      payload: { toolId: record.toolId },
    });
    return accepted && stageAccepted;
  }

  providerUsage(usage: VoiceProviderUsage): boolean {
    return this.emit({
      kind: 'provider.usage',
      provider: usage.provider,
      payload: {
        requestId: usage.requestId ?? null,
        unit: usage.unit,
        quantity: usage.quantity,
        estimated: usage.estimated,
      },
    });
  }

  attachSpeech(scheduler: SchedulerEvidenceSource): () => void {
    return scheduler.subscribe((evidence) => this.speech(evidence));
  }

  private emit(
    event: Omit<TelemetryEvent, keyof BaseFields | 'eventId' | 'sequence' | 'occurredAt'>,
  ): boolean {
    return this.writer.tryEnqueue({
      schemaVersion: 1,
      eventId: randomUUID(),
      workspaceId: this.context.workspaceId,
      callId: this.context.callId,
      sequence: this.context.nextSequence(),
      occurredAt: this.now().toISOString(),
      source: this.context.source,
      agentId: this.context.agentId,
      releaseId: this.context.releaseId,
      language: this.context.language,
      provider: event.provider ?? this.context.provider,
      model: event.model ?? this.context.model,
      ...event,
    });
  }
}

type BaseFields = Pick<
  TelemetryEvent,
  'schemaVersion' | 'workspaceId' | 'callId' | 'source' | 'agentId' | 'releaseId' | 'language'
>;

function operationOutcome(state: OperationRecord['state']): TelemetryOutcome {
  if (state === 'intent' || state === 'running') return 'running';
  if (state === 'succeeded') return 'succeeded';
  if (state === 'unknown') return 'unknown';
  return 'failed';
}
