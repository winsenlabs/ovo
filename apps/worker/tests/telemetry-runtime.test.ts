import { describe, expect, it, vi } from 'vitest';
import type { OperationRecord, OperationStore } from '@winsendotai/ovo-contracts';
import type {
  CallTelemetryProjection,
  PerformanceQuery,
  TelemetryEvent,
  TelemetryRepository,
} from '@winsendotai/ovo-plugin-observability';
import type { StoredCallEvent } from '@winsendotai/ovo-plugin-storage';
import type { SpeechEvidence } from '@winsendotai/ovo-plugin-voice';
import { BoundedCallEventWriter, WorkerTelemetryRuntime } from '../src/telemetry-runtime.ts';

class MemoryTelemetryRepository implements TelemetryRepository {
  readonly events: TelemetryEvent[] = [];
  closed = false;

  async ingest(events: readonly TelemetryEvent[]) {
    this.events.push(...structuredClone(events));
    return { inserted: events.length, duplicates: 0, conflicts: 0 };
  }

  async getCallProjection(): Promise<CallTelemetryProjection> {
    return {
      callId: 'call-1',
      source: 'live',
      lastSequence: 7,
      eventCount: 8,
      gapDetected: false,
      status: 'active',
      stages: [],
      playback: [],
      operations: [],
    };
  }

  async listCallEvents() {
    return { events: [], nextCursor: 0, gap: null };
  }

  async queryPerformance(_workspaceId: string, query: PerformanceQuery) {
    return { from: query.from, to: query.to, bucket: query.bucket, groups: [], truncated: false };
  }

  async prune() {
    return 0;
  }

  async close() {
    this.closed = true;
  }
}

class MemoryCallEvents {
  readonly events: StoredCallEvent[] = [];

  async appendCallEvent(
    _workspaceId: string,
    callId: string,
    type: string,
    payload: Record<string, unknown>,
    epoch = 0,
  ): Promise<StoredCallEvent> {
    const event = {
      id: `event-${this.events.length + 1}`,
      callId,
      sequence: this.events.length,
      at: new Date(1_700_000_000_000 + this.events.length).toISOString(),
      type,
      epoch,
      payload: structuredClone(payload),
    };
    this.events.push(event);
    return event;
  }
}

class EvidenceSource {
  private listener?: (evidence: SpeechEvidence) => void;

  subscribe(listener: (evidence: SpeechEvidence) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(evidence: SpeechEvidence): void {
    this.listener?.(evidence);
  }
}

describe('worker telemetry runtime', () => {
  it('seeds sequence, attaches live evidence, and keeps raw text in access-controlled call events', async () => {
    const repository = new MemoryTelemetryRepository();
    const control = new MemoryCallEvents();
    const runtime = WorkerTelemetryRuntime.fromRepository(repository, {
      controlStore: control,
      maxBatchSize: 100,
    });
    const session = await runtime.createSession({
      workspaceId: 'workspace-1',
      callId: 'call-1',
      agentId: 'agent-1',
      releaseId: 'release-1',
      language: 'en-IN',
      inferenceProvider: 'openai',
      inferenceModel: 'gpt-test',
    });
    const scheduler = new EvidenceSource();
    session.attachScheduler(scheduler);

    session.transcript(
      {
        revision: 3,
        text: 'Please book Tuesday.',
        isFinal: true,
        speechFinal: true,
        confidence: 0.91,
        startMs: 120,
        durationMs: 800,
      },
      true,
    );
    scheduler.emit({
      sequence: 4,
      segmentId: 'segment-1',
      text: 'Your booking is confirmed.',
      epoch: 2,
      kind: 'response',
      phase: 'completed',
      at: 1_700_000_001_000,
      evidence: 'confirmed',
    });
    session.providerUsage({
      provider: 'deepgram',
      operation: 'streaming-stt',
      requestId: 'dg-request',
      elapsedMs: 1_000,
      state: 'reconciled',
      unit: 'audio_seconds',
      quantity: '1.25',
    });
    session.inferenceUsage({
      requestId: 'ai-request',
      modelId: 'gpt-test',
      usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
    });
    const finishInference = session.startStage({
      stage: 'inference',
      provider: 'openai',
      model: 'gpt-test',
    });
    expect(finishInference('succeeded')).toBe(true);
    expect(finishInference('failed')).toBe(false);

    const delegate = memoryOperationStore();
    const operations = session.withOperationStore(delegate);
    const intent = operation('intent');
    expect(await operations.createIntent(intent)).toBe(true);
    await operations.settle({ ...intent, state: 'succeeded', result: { private: true } });
    await session.close('ended', 'carrier-completed');
    await runtime.close();

    expect(repository.closed).toBe(true);
    expect(repository.events[0]).toMatchObject({ kind: 'session.started', sequence: 8 });
    expect(repository.events.map((event) => event.sequence)).toEqual(
      repository.events.map((_, index) => index + 8),
    );
    const transcriptTelemetry = repository.events.find(
      (event) => event.kind === 'transcript.accepted',
    );
    expect(transcriptTelemetry?.payload).toMatchObject({ textLength: 20, isFinal: true });
    expect(transcriptTelemetry?.payload).not.toHaveProperty('text');
    const transcriptAudit = control.events.find((event) => event.type === 'transcript.accepted');
    expect(transcriptAudit?.payload).toMatchObject({
      text: 'Please book Tuesday.',
      transcript: 'Please book Tuesday.',
      accepted: true,
      alignment: { startMs: 120, exactAudioAlignment: false },
    });
    const speechAudit = control.events.find((event) => event.type === 'speech.completed');
    expect(speechAudit?.payload).toMatchObject({
      speechText: 'Your booking is confirmed.',
      segmentId: 'segment-1',
      responseEpoch: 2,
      humanHeard: true,
      alignment: { carrierMarkEvidence: 'confirmed', exactAudioAlignment: false },
    });
    expect(control.events.find((event) => event.type === 'provider.usage')?.payload).toMatchObject({
      requestId: 'dg-request',
      quantity: '1.25',
      state: 'reconciled',
    });
    expect(
      control.events.find((event) => event.type === 'provider.inference-usage')?.payload,
    ).toMatchObject({ usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 } });
    const inferenceStages = repository.events.filter((event) => event.stage === 'inference');
    expect(inferenceStages).toHaveLength(2);
    expect(inferenceStages[0]).toMatchObject({
      kind: 'stage.started',
      outcome: 'running',
      provider: 'openai',
      model: 'gpt-test',
    });
    expect(inferenceStages[1]).toMatchObject({
      kind: 'stage.completed',
      outcome: 'succeeded',
      stageId: inferenceStages[0]?.stageId,
    });
    expect(control.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['operation.intent', 'operation.succeeded']),
    );
    expect(runtime.stats().callEvents).toMatchObject({ dropped: 0, failed: 0, closed: true });
  });

  it('bounds pending call writes and supervises timeout and reporter failures', async () => {
    const pending = deferred<StoredCallEvent>();
    const append = vi.fn(() => pending.promise);
    const errors: Error[] = [];
    const writer = new BoundedCallEventWriter({ appendCallEvent: append }, 2, 100, (error) => {
      errors.push(error);
      throw new Error('reporter failure');
    });
    const event = {
      workspaceId: 'workspace-1',
      callId: 'call-1',
      type: 'transcript.revision',
      payload: { text: 'bounded' },
    };

    expect(writer.tryEnqueue(event)).toBe(true);
    await until(() => append.mock.calls.length === 1);
    expect(writer.tryEnqueue(event)).toBe(true);
    expect(writer.tryEnqueue(event)).toBe(false);
    const startedAt = Date.now();
    await writer.close();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(errors[0]?.message).toBe('Call event flush deadline exceeded');
    expect(writer.stats()).toMatchObject({ accepted: 2, dropped: 2, queued: 1, closed: true });
    pending.resolve(storedEvent());
    await until(() => writer.stats().queued === 0);
  });

  it('catches rejected call writes without unhandled promises', async () => {
    const onError = vi.fn(() => {
      throw new Error('ignored reporter failure');
    });
    const writer = new BoundedCallEventWriter(
      {
        appendCallEvent: async () => {
          throw new Error('database unavailable');
        },
      },
      5,
      500,
      onError,
    );
    writer.tryEnqueue({
      workspaceId: 'workspace-1',
      callId: 'call-1',
      type: 'speech.completed',
      payload: { speechText: 'actual text' },
    });

    await writer.close();

    expect(writer.stats()).toMatchObject({ failed: 1, queued: 0, closed: true });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'database unavailable' }),
    );
  });
});

function memoryOperationStore(): OperationStore {
  const records = new Map<string, OperationRecord>();
  return {
    async createIntent(record) {
      if (records.has(record.id)) return false;
      records.set(record.id, structuredClone(record));
      return true;
    },
    async get(_workspaceId, id) {
      return records.get(id);
    },
    async settle(record) {
      records.set(record.id, structuredClone(record));
    },
  };
}

function operation(state: OperationRecord['state']): OperationRecord {
  return {
    id: 'operation-1',
    workspaceId: 'workspace-1',
    sessionId: 'call-1',
    toolId: 'book',
    input: { date: 'Tuesday' },
    state,
    createdAt: '2026-09-20T00:00:00.000Z',
  };
}

function storedEvent(): StoredCallEvent {
  return {
    id: 'event-1',
    callId: 'call-1',
    sequence: 0,
    at: '2026-09-20T00:00:00.000Z',
    type: 'test',
    epoch: 0,
    payload: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
}
