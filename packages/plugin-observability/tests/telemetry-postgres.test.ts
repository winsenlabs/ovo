import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresTelemetryStore, type TelemetryEvent } from '../src/index.ts';

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
