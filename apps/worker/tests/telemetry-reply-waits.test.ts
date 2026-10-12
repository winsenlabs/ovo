import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@winsendotai/ovo-contracts';
import { ReplyWaitClock, type ReplyWaits } from '../src/telemetry-reply-waits.ts';
import { WorkerTurnTelemetry } from '../src/telemetry-turns.ts';

const replay = JSON.parse(
  readFileSync(new URL('./fixtures/reply-waits-replay.json', import.meta.url), 'utf8'),
) as Record<'turn3' | 'held', EngineEvent[]>;

function waits(events: EngineEvent[]): ReplyWaits[] {
  const recorded: ReplyWaits[] = [];
  const clock = new ReplyWaitClock((w) => recorded.push(w));
  for (const event of events) clock.engine(event);
  return recorded;
}

const parts = (w: ReplyWaits) =>
  w.endpointMs +
  w.queueMs +
  w.composeMs +
  w.fillerCutMs +
  w.startWaitMs +
  w.ttsFirstByteMs +
  w.carrierMs;

describe('reply.waits: where the wait for first reply audio went (Wave 8 fix 3)', () => {
  it('call f3363705 turn 3: the ~0.9 s "gap" is the endpoint and a TTS first byte', () => {
    const [turn] = waits(replay.turn3);
    expect(turn).toEqual({
      turnId: 'turn-3',
      segmentId: 'speech-2',
      firstAudioMs: 2421,
      endpointMs: 840,
      queueMs: 0,
      composeMs: 1435,
      fillerCutMs: 0,
      startWaitMs: 0,
      ttsFirstByteMs: 146,
      carrierMs: 0,
      fillerAudioMs: null,
    });
    expect(parts(turn!)).toBe(turn!.firstAudioMs);
    // Live: firstAudioMs 2424 - firstSegmentMs 1435 = 989 ms, all of it outside the reply.
    expect(turn!.firstAudioMs - turn!.composeMs).toBe(turn!.endpointMs + turn!.ttsFirstByteMs);
  });

  it('a reply held for a cough behind its filler: the hold is its own part', () => {
    const [turn] = waits(replay.held);
    expect(turn).toMatchObject({
      turnId: 'turn-9',
      segmentId: 'speech-3',
      endpointMs: 800,
      composeMs: 2500,
      startWaitMs: 500,
      ttsFirstByteMs: 146,
      fillerAudioMs: 2300,
    });
    expect(parts(turn!)).toBe(turn!.firstAudioMs);
  });

  it('records one per turn, never for a filler alone, and forgets turns that never spoke', () => {
    const fillerOnly = replay.held.filter(
      (event) => !(event.type === 'timing' && event.segmentId === 'speech-3'),
    );
    expect(waits(fillerOnly)).toEqual([]);
    expect(waits([...replay.turn3, ...replay.turn3])).toHaveLength(1);
  });
});

describe('reply.waits on the worker turn telemetry', () => {
  it('is recorded as a stage next to the turn summary, which it adds up to', () => {
    const stages: { stage: string; turnId: string; durationMs: number }[] = [];
    let firstAudioMs: number | null | undefined;
    const turns = new WorkerTurnTelemetry({
      includeText: false,
      emit: (turn) => (firstAudioMs = turn.firstAudioMs),
      stage: (stage) => stages.push(stage),
    });
    for (const event of replay.turn3) turns.engine(event);
    turns.flush();
    expect(stages).toEqual([
      expect.objectContaining({ stage: 'reply.waits', turnId: 'turn-3', durationMs: 2421 }),
    ]);
    expect(firstAudioMs).toBe(2421);
  });
});
