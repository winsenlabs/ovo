import {
  BufferedTelemetryWriter,
  PostgresTelemetryStore,
  WorkerTelemetryAdapter,
  type BufferedTelemetryOptions,
  type TelemetryIngestionStats,
  type TelemetryRepository,
} from '@winsendotai/ovo-plugin-observability';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  BoundedCallEventWriter,
  boundedInteger,
  callEventWriterOptions,
  superviseTelemetry,
  type CallEventWriterStats,
} from './telemetry-event-writer.ts';
import { WorkerSessionTelemetry, type WorkerSessionTelemetryInput } from './telemetry-session.ts';
import {
  transcriptTextFor,
  transcriptTextPolicyFromEnv,
  type TranscriptTextPolicy,
} from './telemetry-privacy.ts';

export { BoundedCallEventWriter } from './telemetry-event-writer.ts';
export type { CallEventWriterStats } from './telemetry-event-writer.ts';
export { WorkerSessionTelemetry } from './telemetry-session.ts';
export type { TranscriptText, TranscriptTextPolicy } from './telemetry-privacy.ts';
export type {
  WorkerSessionTelemetryInput,
  ProviderUsageEvidence,
  InferenceUsageEvidence,
} from './telemetry-session.ts';

const DEFAULT_MAX_TEXT_CHARACTERS = 64_000;

export interface WorkerTelemetryRuntimeOptions extends BufferedTelemetryOptions {
  databaseUrl: string;
  controlStore: Pick<ControlStore, 'appendCallEvent'>;
  maxConnections?: number;
  maxCallEvents?: number;
  callEventFlushTimeoutMs?: number;
  maxTextCharacters?: number;
  /** Defaults to the OVO_TELEMETRY_TRANSCRIPT_TEXT environment policy. */
  transcriptText?: TranscriptTextPolicy;
  onError?: (error: Error) => void;
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
    private readonly transcriptText: TranscriptTextPolicy,
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
      options.transcriptText ?? transcriptTextPolicyFromEnv(),
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
      transcriptTextFor(this.transcriptText, input.agentId, input.transcriptText),
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
    await Promise.all([...this.sessions].map((session) => session.close('error:process_shutdown')));
    await this.callEvents.close();
    await superviseTelemetry(() => this.writer.close(), this.onError);
    await superviseTelemetry(() => this.repository.close?.() ?? Promise.resolve(), this.onError);
  }
}
