import { describe, expect, it } from 'vitest';
import {
  BufferedTelemetryWriter,
  WorkerTelemetryAdapter,
  type TelemetryEvent,
  type TelemetryRepository,
} from '../src/index.ts';

function event(sequence: number): TelemetryEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    workspaceId: 'workspace',
    callId: 'call',
    sequence,
    occurredAt: '2026-09-20T12:00:00.000Z',
    source: 'live',
    kind: 'session.started',
  };
}

function repository(ingest: TelemetryRepository['ingest']): TelemetryRepository {
  return {
    ingest,
    async listCallEvents(_workspaceId, _callId, afterSequence) {
      return { events: [], nextCursor: afterSequence, gap: null };
    },
    async getCallProjection() {
      return undefined;
    },
    async queryPerformance(_workspaceId, query) {
      return { from: query.from, to: query.to, bucket: query.bucket, groups: [], truncated: false };
    },
    async prune() {
      return 0;
    },
  };
}

describe('bounded telemetry ingestion', () => {
  it('never waits on the producer path and exposes drops and persistence failures', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const writer = new BufferedTelemetryWriter(
      repository(async (events) => {
        await blocked;
        return { inserted: events.length, duplicates: 0, conflicts: 0 };
      }),
      { maxQueuedEvents: 2, maxBatchSize: 2, pruneEveryBatches: 10 },
    );
    expect(writer.tryEnqueue(event(0))).toBe(true);
    expect(writer.tryEnqueue(event(1))).toBe(true);
    expect(writer.tryEnqueue(event(2))).toBe(false);
    expect(writer.stats()).toMatchObject({ accepted: 2, dropped: 1, queued: 2 });
    release();
    await writer.close();
    expect(writer.stats()).toMatchObject({ inserted: 2, queued: 0, closed: true });
    expect(writer.tryEnqueue(event(3))).toBe(false);

    const failed = new BufferedTelemetryWriter(
      repository(async () => {
        throw new Error('database unavailable');
      }),
      { maxQueuedEvents: 2 },
    );
    failed.tryEnqueue(event(4));
    await failed.close();
    expect(failed.stats()).toMatchObject({ failedBatches: 1, failedEvents: 1 });
  });

  it('adapts actual scheduler/provider/operation shapes without storing text or tool payloads', async () => {
    const captured: TelemetryEvent[] = [];
    const writer = new BufferedTelemetryWriter(
      repository(async (events) => {
        captured.push(...events);
        return { inserted: events.length, duplicates: 0, conflicts: 0 };
      }),
    );
    let sequence = 0;
    const adapter = new WorkerTelemetryAdapter(writer, {
      workspaceId: 'workspace',
      callId: 'call',
      source: 'simulation',
      agentId: 'agent',
      releaseId: 'release',
      language: 'en-IN',
      nextSequence: () => sequence++,
      now: () => new Date('2026-09-20T12:00:00.000Z'),
    });
    adapter.transcript(
      { revision: 1, text: 'private caller words', isFinal: true, speechFinal: true },
      true,
    );
    adapter.speech({
      sequence: 0,
      segmentId: 'segment',
      text: 'private response words',
      epoch: 3,
      kind: 'response',
      phase: 'completed',
      at: 1,
      evidence: 'confirmed',
    });
    adapter.operation({
      id: 'operation',
      workspaceId: 'workspace',
      sessionId: 'call',
      toolId: 'balance',
      input: { account: 'secret' },
      result: { balance: 'secret' },
      state: 'succeeded',
      createdAt: '2026-09-20T12:00:00.000Z',
    });
    await writer.close();
    expect(captured.map((item) => item.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(JSON.stringify(captured)).not.toContain('private caller words');
    expect(JSON.stringify(captured)).not.toContain('private response words');
    expect(JSON.stringify(captured)).not.toContain('account');
    expect(captured[1]).toMatchObject({
      kind: 'playback.completed',
      evidence: 'confirmed',
      payload: { textLength: 22 },
    });
    expect(captured[2]).toMatchObject({ kind: 'stage.completed', stage: 'playback' });
    expect(captured[4]).toMatchObject({ kind: 'stage.completed', stage: 'operation' });
  });
});
