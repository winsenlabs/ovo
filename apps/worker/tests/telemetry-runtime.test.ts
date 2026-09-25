import { describe, expect, it, vi } from 'vitest';
import type {
  EngineEvent,
  OperationRecord,
  OperationStore,
  VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import type {
  CallTelemetryProjection,
  PerformanceQuery,
  TelemetryEvent,
  TelemetryRepository,
} from '@winsendotai/ovo-plugin-observability';
import { projectLatencyBreakdowns } from '@winsendotai/ovo-plugin-observability';
import type { StoredCallEvent } from '@winsendotai/ovo-plugin-storage';
import type { SpeechEvidence } from '@winsendotai/ovo-plugin-voice';
import { BoundedCallEventWriter, WorkerTelemetryRuntime } from '../src/telemetry-runtime.ts';
import { subscribeEngineTelemetry } from '../src/session-graph-host.ts';

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

  constructor(private readonly persistedAtMs = 1_700_000_000_000) {}

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
      at: new Date(this.persistedAtMs + this.events.length).toISOString(),
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

const sessionIdentity = () => ({
  workspaceId: 'workspace-1',
  callId: 'call-1',
  agentId: 'agent-1',
  releaseId: 'release-1',
  language: 'en-IN',
});

describe('worker telemetry runtime', () => {
  it('seeds sequence, attaches live evidence, and keeps raw text in access-controlled call events', async () => {
    const repository = new MemoryTelemetryRepository();
    const control = new MemoryCallEvents();
    const runtime = WorkerTelemetryRuntime.fromRepository(repository, {
      controlStore: control,
      maxBatchSize: 100,
    });
    const session = await runtime.createSession({
      ...sessionIdentity(),
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
    await session.close('behavior_completed');
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

  it('uses the typed reason for caller-ended outcome even with the legacy close argument', async () => {
    const repository = new MemoryTelemetryRepository();
    const control = new MemoryCallEvents();
    const runtime = WorkerTelemetryRuntime.fromRepository(repository, { controlStore: control });
    const session = await runtime.createSession(sessionIdentity());
    await session.close('failed', 'caller_hangup');
    await runtime.close();
    expect(repository.events.find((event) => event.kind === 'session.ended')).toMatchObject({
      payload: { reason: 'caller_hangup', callOutcome: 'caller_ended' },
    });
    expect(control.events.find((event) => event.type === 'session.ended')).toMatchObject({
      payload: { reason: 'caller_hangup', outcome: 'caller_ended' },
    });
  });

  it('records engine observation time before delayed call-event persistence', async () => {
    const observedAtMs = 1_800_000_000_000;
    const control = new MemoryCallEvents(observedAtMs + 200);
    const runtime = WorkerTelemetryRuntime.fromRepository(new MemoryTelemetryRepository(), {
      controlStore: control,
    });
    const session = await runtime.createSession(sessionIdentity());
    const now = vi.spyOn(Date, 'now').mockReturnValue(observedAtMs);
    try {
      session.engineEvent({ type: 'user.turn', phase: 'stopped', turnId: 'turn-1' });
      session.engineEvent({
        type: 'timing',
        turnId: 'turn-1',
        key: 'carrier_first_audio',
        atMs: observedAtMs + 5,
      });
    } finally {
      now.mockRestore();
    }
    await session.close('behavior_completed');
    await runtime.close();
    const rows = control.events.filter((row) => row.type === 'engine.event');
    const events = rows.map((row) => row.payload.event as EngineEvent);
    const measured = projectLatencyBreakdowns(
      events,
      observedAtMs - 1_000,
      rows.map((row) =>
        typeof row.payload.atMs === 'number' ? row.payload.atMs : Date.parse(row.at),
      ),
    );
    expect(measured).toMatchObject([
      { turnId: 'turn-1', measuredFrom: 'user_silence', totalMs: 5 },
    ]);
  });

  it('persists the exact engine event stream for live transcript and timing inspection', async () => {
    const repository = new MemoryTelemetryRepository();
    const control = new MemoryCallEvents();
    const runtime = WorkerTelemetryRuntime.fromRepository(repository, { controlStore: control });
    const session = await runtime.createSession(sessionIdentity());
    let emit!: (event: EngineEvent) => void;
    const engine = {
      subscribe(listener: (event: EngineEvent) => void) {
        emit = listener;
        return () => undefined;
      },
    } as VoiceSessionEngine;
    const unsubscribe = subscribeEngineTelemetry(engine, session);
    emit({
      type: 'user.transcript',
      turnId: 'turn-1',
      segmentId: 'segment-1',
      text: 'I need help',
      stability: 'interim',
    });
    emit({ type: 'user.turn', turnId: 'turn-1', phase: 'stopped', input: 'speech' });
    emit({ type: 'timing', turnId: 'turn-1', key: 'tts_ttfb', atMs: 240, ms: 40 });
    unsubscribe();
    await session.close('caller_hangup');
    await runtime.close();
    expect(
      control.events
        .filter((event) => event.type === 'engine.event')
        .map((event) => event.payload.event),
    ).toEqual([
      {
        type: 'user.transcript',
        turnId: 'turn-1',
        segmentId: 'segment-1',
        text: 'I need help',
        stability: 'interim',
      },
      { type: 'user.turn', turnId: 'turn-1', phase: 'stopped', input: 'speech' },
      { type: 'timing', turnId: 'turn-1', key: 'tts_ttfb', atMs: 240, ms: 40 },
    ]);
    expect(control.events.filter((event) => event.type === 'transcript.accepted')).toEqual([]);
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
