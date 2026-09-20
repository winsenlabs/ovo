import type { OperationRecord, OperationStore } from '@winsendotai/ovo-contracts';
import {
  BufferedTelemetryWriter,
  PostgresTelemetryStore,
  WorkerTelemetryAdapter,
  type BufferedTelemetryOptions,
  type TelemetryIngestionStats,
  type TelemetryRepository,
  type TelemetryOutcome,
} from '@winsendotai/ovo-plugin-observability';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { SpeechEvidence, TranscriptRevision } from '@winsendotai/ovo-plugin-voice';
import {
  BoundedCallEventWriter,
  boundedEvidenceText,
  boundedInteger,
  callEventWriterOptions,
  superviseTelemetry,
  telemetryError,
  type CallEventWriterStats,
  voiceUsageUnit,
} from './telemetry-event-writer.ts';

export { BoundedCallEventWriter } from './telemetry-event-writer.ts';
export type { CallEventWriterStats } from './telemetry-event-writer.ts';

const DEFAULT_MAX_TEXT_CHARACTERS = 64_000;

export interface WorkerTelemetryRuntimeOptions extends BufferedTelemetryOptions {
  databaseUrl: string;
  controlStore: Pick<ControlStore, 'appendCallEvent'>;
  maxConnections?: number;
  maxCallEvents?: number;
  callEventFlushTimeoutMs?: number;
  maxTextCharacters?: number;
  onError?: (error: Error) => void;
}

export interface WorkerSessionTelemetryInput {
  workspaceId: string;
  callId: string;
  agentId: string;
  releaseId: string;
  language: string;
  inferenceProvider?: string;
  inferenceModel?: string;
}

export interface ProviderUsageEvidence {
  provider: string;
  operation: string;
  requestId?: string;
  elapsedMs: number;
  state: 'estimated' | 'reconciled' | 'unavailable';
  unit: string;
  quantity?: string;
  missing?: string;
}

export interface InferenceUsageEvidence {
  requestId?: string;
  modelId?: string;
  usage: Record<string, number>;
}

interface SchedulerEvidenceSource {
  subscribe(listener: (evidence: SpeechEvidence) => void): () => void;
}

interface ClosableTelemetryRepository extends TelemetryRepository {
  close?(): Promise<void>;
}

export class WorkerTelemetryRuntime {
  readonly writer: BufferedTelemetryWriter;
  readonly callEvents: BoundedCallEventWriter;
  private readonly sessions = new Set<WorkerSessionTelemetry>();
  private closed = false;

  private constructor(
    readonly repository: ClosableTelemetryRepository,
    controlStore: Pick<ControlStore, 'appendCallEvent'>,
    private readonly maxTextCharacters: number,
    private readonly onError: (error: Error) => void,
    writerOptions: BufferedTelemetryOptions,
    callEventOptions: { maxQueuedEvents: number; flushTimeoutMs: number },
  ) {
    this.writer = new BufferedTelemetryWriter(repository, writerOptions);
    this.callEvents = new BoundedCallEventWriter(
      controlStore,
      callEventOptions.maxQueuedEvents,
      callEventOptions.flushTimeoutMs,
      onError,
    );
  }

  static async open(options: WorkerTelemetryRuntimeOptions): Promise<WorkerTelemetryRuntime> {
    const repository = await PostgresTelemetryStore.open({
      connectionString: options.databaseUrl,
      maxConnections: options.maxConnections ?? 2,
    });
    try {
      return WorkerTelemetryRuntime.fromRepository(repository, options);
    } catch (error) {
      await repository.close().catch(() => undefined);
      throw error;
    }
  }

  static fromRepository(
    repository: ClosableTelemetryRepository,
    options: Omit<WorkerTelemetryRuntimeOptions, 'databaseUrl' | 'maxConnections'>,
  ): WorkerTelemetryRuntime {
    const maxTextCharacters = options.maxTextCharacters ?? DEFAULT_MAX_TEXT_CHARACTERS;
    boundedInteger(maxTextCharacters, 1, 256_000, 'maxTextCharacters');
    return new WorkerTelemetryRuntime(
      repository,
      options.controlStore,
      maxTextCharacters,
      options.onError ?? (() => undefined),
      options,
      callEventWriterOptions(options),
    );
  }

  async createSession(input: WorkerSessionTelemetryInput): Promise<WorkerSessionTelemetry> {
    if (this.closed) throw new Error('Worker telemetry runtime is closed');
    const duplicate = [...this.sessions].some(
      (session) => session.workspaceId === input.workspaceId && session.callId === input.callId,
    );
    if (duplicate) throw new Error('Telemetry session is already attached to this call');
    const projection = await this.repository.getCallProjection(input.workspaceId, input.callId, 1);
    let sequence = (projection?.lastSequence ?? -1) + 1;
    const adapter = new WorkerTelemetryAdapter(this.writer, {
      ...input,
      source: 'live',
      provider: input.inferenceProvider,
      model: input.inferenceModel,
      nextSequence: () => sequence++,
    });
    const session = new WorkerSessionTelemetry(
      input,
      adapter,
      this.callEvents,
      this.maxTextCharacters,
      () => this.sessions.delete(session),
      this.onError,
    );
    this.sessions.add(session);
    session.started();
    return session;
  }

  stats(): { telemetry: TelemetryIngestionStats; callEvents: CallEventWriterStats } {
    return { telemetry: this.writer.stats(), callEvents: this.callEvents.stats() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      [...this.sessions].map((session) => session.close('failed', 'process_shutdown')),
    );
    await this.callEvents.close();
    await superviseTelemetry(() => this.writer.close(), this.onError);
    await superviseTelemetry(() => this.repository.close?.() ?? Promise.resolve(), this.onError);
  }
}

export class WorkerSessionTelemetry {
  readonly workspaceId: string;
  readonly callId: string;
  private readonly detach = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly input: WorkerSessionTelemetryInput,
    readonly adapter: WorkerTelemetryAdapter,
    private readonly events: BoundedCallEventWriter,
    private readonly maxTextCharacters: number,
    private readonly onClose: () => void,
    private readonly onError: (error: Error) => void,
  ) {
    this.workspaceId = input.workspaceId;
    this.callId = input.callId;
  }

  withOperationStore(delegate: OperationStore): OperationStore {
    const record = (operation: OperationRecord) => {
      this.adapter.operation(operation);
      this.audit(`operation.${operation.state}`, {
        operationId: operation.id,
        toolId: operation.toolId,
        state: operation.state,
        hasResult: operation.result !== undefined,
      });
    };
    return {
      createIntent: async (operation) => {
        const created = await delegate.createIntent(operation);
        if (created) record(operation);
        return created;
      },
      get: (workspaceId, id) => delegate.get(workspaceId, id),
      settle: async (operation) => {
        await delegate.settle(operation);
        record(operation);
      },
    };
  }

  started(): void {
    this.adapter.sessionStarted();
    this.audit('session.started', { source: 'live' });
  }

  attachScheduler(scheduler: SchedulerEvidenceSource): () => void {
    const unsubscribe = scheduler.subscribe((evidence) => {
      this.adapter.speech(evidence);
      this.speechEvent(evidence);
    });
    this.detach.add(unsubscribe);
    return () => {
      this.detach.delete(unsubscribe);
      unsubscribe();
    };
  }

  transcript(revision: TranscriptRevision, accepted = false): void {
    this.adapter.transcript(revision, accepted);
    const text = boundedEvidenceText(revision.text, this.maxTextCharacters);
    this.audit(accepted ? 'transcript.accepted' : 'transcript.revision', {
      speaker: 'caller',
      role: 'user',
      text: text.value,
      transcript: text.value,
      textTruncated: text.truncated,
      revision: revision.revision,
      isFinal: revision.isFinal,
      speechFinal: revision.speechFinal,
      speechStarted: revision.speechStarted ?? false,
      confidence: revision.confidence ?? null,
      alignment: {
        clock: revision.startMs === undefined ? 'worker-received-wall-clock' : 'provider-relative',
        startMs: revision.startMs ?? null,
        durationMs: revision.durationMs ?? null,
        exactAudioAlignment: false,
      },
      accepted,
    });
  }

  providerUsage(usage: ProviderUsageEvidence): void {
    const quantity = usage.quantity === undefined ? undefined : Number(usage.quantity);
    const unit = voiceUsageUnit(usage.unit);
    if (quantity !== undefined && Number.isFinite(quantity) && quantity >= 0 && unit) {
      this.adapter.providerUsage({
        provider: usage.provider,
        requestId: usage.requestId,
        unit,
        quantity,
        estimated: usage.state !== 'reconciled',
      });
    }
    this.audit('provider.usage', {
      provider: usage.provider,
      operation: usage.operation,
      requestId: usage.requestId ?? null,
      elapsedMs: usage.elapsedMs,
      state: usage.state,
      unit: usage.unit,
      quantity: usage.quantity ?? null,
      missing: usage.missing ?? null,
    });
  }

  inferenceUsage(evidence: InferenceUsageEvidence): void {
    const total = evidence.usage.totalTokens;
    if (Number.isFinite(total) && total >= 0) {
      this.adapter.providerUsage({
        provider: this.input.inferenceProvider ?? 'inference',
        requestId: evidence.requestId,
        unit: 'tokens',
        quantity: total,
        estimated: false,
      });
    }
    this.audit('provider.inference-usage', {
      provider: this.input.inferenceProvider ?? null,
      requestId: evidence.requestId ?? null,
      modelId: evidence.modelId ?? this.input.inferenceModel ?? null,
      usage: structuredClone(evidence.usage),
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
    return this.adapter.startStage(input);
  }

  async close(outcome: 'ended' | 'failed', reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.detach) {
      try {
        unsubscribe();
      } catch (error) {
        try {
          this.onError(telemetryError(error));
        } catch {
          // Teardown and telemetry remain independent of error reporting.
        }
      }
    }
    this.detach.clear();
    this.adapter.sessionEnded(outcome, reason);
    this.audit(outcome === 'ended' ? 'session.ended' : 'session.failed', {
      reason: reason ? boundedEvidenceText(reason, 500).value : null,
    });
    this.onClose();
  }

  private speechEvent(evidence: SpeechEvidence): void {
    const terminal = ['completed', 'interrupted', 'dropped', 'failed'].includes(evidence.phase);
    const includeText = evidence.phase === 'generated' || terminal;
    const text = includeText
      ? boundedEvidenceText(evidence.text, this.maxTextCharacters)
      : undefined;
    this.audit(
      `speech.${evidence.phase}`,
      {
        speaker: 'agent',
        role: 'assistant',
        segmentId: evidence.segmentId,
        responseId: `${this.callId}:${evidence.epoch}`,
        turnId: String(evidence.epoch),
        responseEpoch: evidence.epoch,
        speechKind: evidence.kind,
        phase: evidence.phase,
        text: text?.value ?? null,
        speechText: text?.value ?? null,
        textLength: evidence.text.length,
        textTruncated: text?.truncated ?? false,
        evidence: evidence.evidence,
        humanHeard: evidence.phase === 'completed' && evidence.evidence === 'confirmed',
        reason: evidence.reason ? boundedEvidenceText(evidence.reason, 500).value : null,
        alignment: {
          clock: 'worker-wall-clock',
          occurredAt: new Date(evidence.at).toISOString(),
          exactAudioAlignment: false,
          carrierMarkEvidence: evidence.evidence,
        },
      },
      evidence.epoch,
    );
  }

  audit(type: string, payload: Record<string, unknown>, epoch?: number): boolean {
    return this.events.tryEnqueue({
      workspaceId: this.workspaceId,
      callId: this.callId,
      type,
      payload,
      epoch,
    });
  }
}
