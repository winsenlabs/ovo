import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BufferedTelemetryWriter,
  createFixtureTelemetry,
  PostgresTelemetryStore,
  type TelemetryEvent,
} from '../src/index.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

integration('Postgres telemetry projections and performance', () => {
  let store: PostgresTelemetryStore;
  const workspaceId = `telemetry-${randomUUID()}`;

  beforeAll(async () => {
    const cleanup = new Pool({ connectionString: databaseUrl });
    const tables = await cleanup.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname=current_schema() AND tablename LIKE 'ovo_telemetry_%'`,
    );
    for (const { tablename } of tables.rows) {
      if (!/^ovo_telemetry_[a-z_]+$/.test(tablename)) throw new Error('Unexpected table prefix');
      await cleanup.query(`DROP TABLE ${tablename} CASCADE`);
    }
    await cleanup.end();
    store = await PostgresTelemetryStore.open(databaseUrl!);
  });

  afterAll(async () => store?.close());

  it('guards duplicates and conflicts while projecting out-of-order call evidence', async () => {
    const callId = randomUUID();
    const zero = telemetry(callId, 0, 'session.started');
    const operation = telemetry(callId, 1, 'operation.succeeded', {
      operationId: 'operation-1',
      payload: { toolId: 'balance' },
      outcome: 'succeeded',
    });
    const playback = telemetry(callId, 2, 'playback.completed', {
      segmentId: 'segment-1',
      responseEpoch: 4,
      evidence: 'confirmed',
      payload: { speechKind: 'response' },
    });
    const result = await store.ingest([
      playback,
      zero,
      operation,
      operation,
      { ...operation, eventId: randomUUID(), kind: 'operation.failed' },
    ]);
    expect(result).toEqual({ inserted: 3, duplicates: 1, conflicts: 1 });
    expect(await store.getCallProjection(workspaceId, callId)).toMatchObject({
      lastSequence: 2,
      eventCount: 3,
      gapDetected: false,
      playback: [{ segmentId: 'segment-1', terminalState: 'completed', evidence: 'confirmed' }],
      operations: [{ operationId: 'operation-1', state: 'succeeded', toolId: 'balance' }],
    });
    const resumed = await store.listCallEvents(workspaceId, callId, 0, 20);
    expect(resumed.events.map((item) => item.sequence)).toEqual([1, 2]);
    expect(resumed.nextCursor).toBe(2);
    expect(resumed.gap).toBeNull();
  });

  it('computes real PostgreSQL percentiles by cohort and preserves missing metrics as null', async () => {
    const durations = [10, 20, 30];
    await store.ingest(
      durations.map((duration, index) =>
        telemetry(randomUUID(), 0, 'stage.completed', {
          stageId: `stage-${index}`,
          stage: 'inference',
          provider: 'openai',
          model: 'gpt-fixture',
          durationMs: duration,
          outcome: 'succeeded',
        }),
      ),
    );
    await store.ingest([
      telemetry(randomUUID(), 0, 'stage.completed', {
        stageId: 'missing-stage',
        stage: 'stt',
        provider: 'deepgram',
        outcome: 'succeeded',
      }),
      telemetry(randomUUID(), 0, 'stage.timeout', {
        stageId: 'simulated-stage',
        stage: 'inference',
        source: 'simulation',
        provider: 'openai',
        durationMs: 1_000,
        outcome: 'timeout',
      }),
    ]);
    const query = {
      from: '2026-09-20T00:00:00.000Z',
      to: '2026-09-21T00:00:00.000Z',
      bucket: 'hour' as const,
      groupBy: ['provider', 'model', 'language', 'stage', 'source'] as const,
    };
    const live = await store.queryPerformance(workspaceId, { ...query, source: 'live' });
    const inference = live.groups.find((group) => group.cohort.stage === 'inference')!;
    expect(inference).toMatchObject({
      eventCount: 3,
      sampleCount: 3,
      errors: 0,
      timeouts: 0,
      p50Ms: 20,
      p95Ms: 29,
      p99Ms: 29.8,
    });
    expect(new Set(inference.callIds).size).toBe(3);
    const missing = live.groups.find((group) => group.cohort.stage === 'stt')!;
    expect(missing).toMatchObject({ sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null });
    const simulated = await store.queryPerformance(workspaceId, {
      ...query,
      source: 'simulation',
    });
    expect(simulated.groups[0]).toMatchObject({ sampleCount: 1, timeouts: 1, p50Ms: 1_000 });
  });

  it('persists fixture call telemetry and includes it in the test performance cohort', async () => {
    const callId = randomUUID();
    const writer = new BufferedTelemetryWriter(store);
    try {
      const trace = createFixtureTelemetry(writer, {
        workspaceId,
        callId,
        agentId: 'agent-a',
        releaseId: 'release-a',
        language: 'en-IN',
      })!;
      trace.started();
      trace.event({
        seq: 1,
        atMs: Date.now(),
        event: {
          type: 'user.transcript',
          turnId: 'turn-1',
          segmentId: 'segment-1',
          text: 'hello',
          stability: 'final',
        },
      });
      trace.event({
        seq: 2,
        atMs: Date.now(),
        event: {
          type: 'timing',
          turnId: 'turn-1',
          key: 'tts_ttfb',
          atMs: Date.now(),
          ms: 42,
        },
      });
      trace.usage({
        provider: 'fixture',
        operation: 'tts',
        unit: 'characters',
        quantity: '5',
        state: 'estimated',
        requestId: 'fixture-usage',
        elapsedMs: 42,
      });
      trace.ended('behavior_completed');
      await writer.flush();
      // The fifth event is the turn's summary, published when the call ends.
      expect(await store.getCallProjection(workspaceId, callId)).toMatchObject({
        source: 'test',
        status: 'ended',
        eventCount: 6,
      });
      expect(await store.listCallTurns(workspaceId, callId)).toEqual([
        expect.objectContaining({ turnId: 'turn-1', input: 'agent', textOmitted: false }),
      ]);
      const groups = await store.queryPerformance(workspaceId, {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
        bucket: 'hour',
        source: 'test',
        groupBy: ['source', 'stage'],
      });
      expect(groups.groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cohort: expect.objectContaining({ source: 'test', stage: 'tts_ttfb' }),
            sampleCount: 1,
            p50Ms: 42,
          }),
        ]),
      );
    } finally {
      await writer.close();
    }
  });

  it('reports persisted sequence gaps without duplicating cursor resumes', async () => {
    const callId = randomUUID();
    await store.ingest([
      telemetry(callId, 0, 'session.started'),
      telemetry(callId, 2, 'session.ended'),
    ]);
    const page = await store.listCallEvents(workspaceId, callId, 0);
    expect(page.events.map((item) => item.sequence)).toEqual([2]);
    expect(page.gap).toEqual({ expected: 1, actual: 2 });
    expect(await store.getCallProjection(workspaceId, callId)).toMatchObject({ gapDetected: true });
    expect((await store.listCallEvents(workspaceId, callId, page.nextCursor)).events).toEqual([]);
  });

  it('prunes raw events and projections in bounded retention batches', async () => {
    const callId = randomUUID();
    await store.ingest([
      {
        ...telemetry(callId, 0, 'stage.completed', {
          stageId: 'expired-stage',
          stage: 'tts',
          durationMs: 12,
          outcome: 'succeeded',
        }),
        occurredAt: '2000-01-01T00:00:00.000Z',
      },
    ]);
    expect(await store.prune('2001-01-01T00:00:00.000Z', 1)).toBe(1);
    expect((await store.listCallEvents(workspaceId, callId, -1)).events).toEqual([]);
    expect(await store.getCallProjection(workspaceId, callId)).toBeUndefined();
  });

  it('keeps the newest per-turn summary in turn order and prunes it with the rest', async () => {
    const callId = randomUUID();
    const summary = (turnId: string, startedAt: string, firstAudioMs: number | null) => ({
      turnId,
      input: 'speech',
      startedAt,
      firstAudioMs,
      userText: 'hello',
      agentText: null,
      textOmitted: false,
    });
    const turn = (sequence: number, turnId: string, value: Record<string, unknown>) =>
      telemetry(callId, sequence, 'turn.summary', { turnId, payload: { summary: value } });
    await store.ingest([
      telemetry(callId, 0, 'session.started'),
      turn(3, 'turn-2', summary('turn-2', '2026-09-20T12:00:05.000Z', 900)),
      turn(2, 'turn-1', summary('turn-1', '2026-09-20T12:00:01.000Z', 1_500)),
      // An older snapshot arriving late never replaces the newer one.
      turn(1, 'turn-1', summary('turn-1', '2026-09-20T12:00:01.000Z', null)),
    ]);
    expect(await store.listCallTurns(workspaceId, callId)).toEqual([
      expect.objectContaining({ turnId: 'turn-1', firstAudioMs: 1_500, userText: 'hello' }),
      expect.objectContaining({ turnId: 'turn-2', firstAudioMs: 900 }),
    ]);
    const versions = new Pool({ connectionString: databaseUrl });
    try {
      const applied = await versions.query<{ version: number }>(
        'SELECT version FROM ovo_telemetry_schema_migrations ORDER BY version',
      );
      expect(applied.rows.map((row) => row.version)).toEqual([1, 2, 3]);
    } finally {
      await versions.end();
    }
    await store.prune('2026-09-21T00:00:00.000Z', 10);
    expect(await store.listCallTurns(workspaceId, callId)).toEqual([]);
  });

  function telemetry(
    callId: string,
    sequence: number,
    kind: TelemetryEvent['kind'],
    overrides: Partial<TelemetryEvent> = {},
  ): TelemetryEvent {
    return {
      schemaVersion: 1,
      eventId: randomUUID(),
      workspaceId,
      callId,
      sequence,
      occurredAt: `2026-09-20T12:00:${String(sequence).padStart(2, '0')}.000Z`,
      source: 'live',
      kind,
      agentId: 'agent-a',
      releaseId: 'release-a',
      language: 'en-IN',
      ...overrides,
    };
  }
});
