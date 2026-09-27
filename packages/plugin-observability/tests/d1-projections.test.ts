import { createHash } from 'node:crypto';
import { canonicalJson, type EngineEvent } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  BufferedTelemetryWriter,
  WorkerTelemetryAdapter,
  projectLatencyBreakdowns,
  projectTranscript,
  subscribeLatencyBreakdowns,
  type TelemetryEvent,
  type TelemetryRepository,
} from '../src/index.ts';
import { telemetryEventHash } from '../src/telemetry-validation.ts';

describe('D1 EngineEvent projections', () => {
  it('partitions elapsed latency without adding overlapping stage durations', () => {
    const events: EngineEvent[] = [
      { type: 'user.turn', phase: 'stopped', turnId: 'turn-1' },
      { type: 'timing', turnId: 'turn-1', key: 'stt_finalize', atMs: 120, ms: 20 },
      { type: 'timing', turnId: 'turn-1', key: 'tts_ttfb', atMs: 150, ms: 50 },
      { type: 'timing', turnId: 'turn-1', key: 'carrier_first_audio', atMs: 160, ms: 60 },
      { type: 'timing', turnId: 'turn-1', key: 'playout_ack', atMs: 180, ms: 80 },
    ];
    const [latency] = projectLatencyBreakdowns(events, 0, [100, 120, 150, 160, 180]);
    expect(latency).toMatchObject({
      turnId: 'turn-1',
      measuredFrom: 'user_silence',
      totalMs: 80,
      interrupted: false,
      parts: [
        { key: 'stt_finalize', ownerKind: 'service', ms: 20 },
        { key: 'tts_ttfb', ownerKind: 'service', ms: 30 },
        { key: 'carrier_first_audio', ownerKind: 'carrier', ms: 10 },
        { key: 'playout_ack', ownerKind: 'carrier', ms: 20 },
      ],
    });
    expect(latency.parts.reduce((sum, part) => sum + part.ms, 0)).toBe(latency.totalMs);
  });

  it('uses the observed stopped-turn time when carrier timings omit stage durations', () => {
    const events: EngineEvent[] = [
      { type: 'user.turn', phase: 'stopped', turnId: 'turn-1' },
      { type: 'timing', turnId: 'turn-1', key: 'carrier_first_audio', atMs: 1_000 },
      { type: 'timing', turnId: 'turn-1', key: 'playout_ack', atMs: 1_200 },
    ];
    expect(projectLatencyBreakdowns(events, 0, [0, 1_000, 1_200])).toMatchObject([
      {
        measuredFrom: 'user_silence',
        totalMs: 1_200,
        parts: [{ ms: 1_000 }, { ms: 200 }],
      },
    ]);
    expect(projectLatencyBreakdowns(events, 0)[0]?.measuredFrom).toBe('call_start');
  });

  it('projects a call-start turn and marks interruption', () => {
    const events: EngineEvent[] = [
      { type: 'timing', key: 'tts_ttfb', atMs: 15, ms: 15 },
      { type: 'agent.transcript', segmentId: 'intro', state: 'interrupted', text: 'Welcome' },
      { type: 'timing', key: 'carrier_first_audio', atMs: 25, segmentId: 'intro' },
    ];
    expect(projectLatencyBreakdowns(events, 0)).toEqual([
      {
        turnId: 'call_start',
        measuredFrom: 'call_start',
        totalMs: 25,
        parts: [
          { key: 'tts_ttfb', ownerKind: 'service', ms: 15 },
          { key: 'carrier_first_audio', ownerKind: 'carrier', ms: 10 },
        ],
        interrupted: true,
      },
    ]);
    const subscribers: ((event: EngineEvent) => void)[] = [];
    const received: unknown[] = [];
    const unsubscribe = subscribeLatencyBreakdowns(
      {
        subscribe(listener) {
          subscribers.push(listener);
          return () => subscribers.pop();
        },
      },
      (item) => received.push(item),
      0,
    );
    for (const event of events) subscribers[0]!(event);
    subscribers[0]!({ type: 'end', reason: 'caller_hangup' });
    expect(received).toEqual(projectLatencyBreakdowns(events, 0));
    unsubscribe();
  });

  it('keeps multiple acknowledged segments in one turn', () => {
    const events: EngineEvent[] = [
      { type: 'user.turn', phase: 'stopped', turnId: 'turn' },
      { type: 'timing', turnId: 'turn', key: 'tts_ttfb', atMs: 10, ms: 10 },
      { type: 'timing', turnId: 'turn', key: 'playout_ack', atMs: 20, ms: 10 },
      { type: 'timing', turnId: 'turn', key: 'tts_ttfb', atMs: 30, ms: 10 },
      { type: 'timing', turnId: 'turn', key: 'playout_ack', atMs: 40, ms: 10 },
    ];
    expect(projectLatencyBreakdowns(events, 0, [0, 10, 20, 30, 40])).toMatchObject([
      { turnId: 'turn', totalMs: 40, parts: [{ ms: 10 }, { ms: 10 }, { ms: 10 }, { ms: 10 }] },
    ]);
  });

  it('retains user interim/final and agent generated/played/interrupted separately', () => {
    const transcript = projectTranscript([
      {
        type: 'user.transcript',
        turnId: 'turn',
        segmentId: 'user',
        text: 'hel',
        stability: 'interim',
      },
      {
        type: 'user.transcript',
        turnId: 'turn',
        segmentId: 'user',
        text: 'hello',
        stability: 'final',
      },
      { type: 'agent.transcript', segmentId: 'agent', text: 'hello there', state: 'generated' },
      { type: 'agent.transcript', segmentId: 'agent', text: 'hello there', state: 'played' },
      {
        type: 'agent.transcript',
        segmentId: 'next',
        text: 'goodbye',
        state: 'interrupted',
        spokenPrefix: 'good',
      },
      { type: 'end', reason: 'caller_hangup' },
    ]);
    expect(transcript.map((entry) => entry.type)).toEqual([
      'transcript.user.interim',
      'transcript.user.final',
      'transcript.agent.generated',
      'transcript.agent.played',
      'transcript.agent.interrupted',
    ]);
    expect(transcript.at(-1)).toMatchObject({ spokenPrefix: 'good' });
  });
});

describe('D1 telemetry outcome and hashing', () => {
  it('projects caller_hangup as caller_ended rather than a failure', async () => {
    const captured: TelemetryEvent[] = [];
    const repository = {
      async ingest(events: readonly TelemetryEvent[]) {
        captured.push(...events);
        return { inserted: events.length, duplicates: 0, conflicts: 0 };
      },
    } as TelemetryRepository;
    const writer = new BufferedTelemetryWriter(repository);
    let sequence = 0;
    const adapter = new WorkerTelemetryAdapter(writer, {
      workspaceId: 'workspace',
      callId: 'call',
      source: 'simulation',
      agentId: 'agent',
      releaseId: 'release',
      language: 'en-IN',
      nextSequence: () => sequence++,
    });
    adapter.sessionEnded('caller_hangup');
    adapter.sessionEnded('behavior_completed');
    adapter.sessionEnded('ownership_lost');
    await writer.close();
    expect(captured.map(({ kind, outcome, payload }) => ({ kind, outcome, payload }))).toEqual([
      {
        kind: 'session.ended',
        outcome: 'succeeded',
        payload: { reason: 'caller_hangup', callOutcome: 'caller_ended' },
      },
      {
        kind: 'session.ended',
        outcome: 'succeeded',
        payload: { reason: 'behavior_completed', callOutcome: 'completed' },
      },
      {
        kind: 'session.failed',
        outcome: 'failed',
        payload: { reason: 'ownership_lost', callOutcome: 'failed' },
      },
    ]);
  });

  it('hashes object keys in code-unit order, including case and non-ASCII', () => {
    const event: TelemetryEvent = {
      schemaVersion: 1,
      eventId: 'event',
      workspaceId: 'workspace',
      callId: 'call',
      sequence: 0,
      occurredAt: '2026-09-25T00:00:00.000Z',
      source: 'live',
      kind: 'session.started',
      payload: { a: 1, A: 2, é: 3, z: 4 },
    };
    const ordered = canonicalJson(event);
    expect(ordered).toContain('"payload":{"A":2,"a":1,"z":4,"é":3}');
    expect(telemetryEventHash(event).toString('hex')).toBe(
      createHash('sha256').update(ordered).digest('hex'),
    );
  });
});
