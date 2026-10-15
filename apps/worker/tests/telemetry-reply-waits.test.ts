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
      // Nothing played between the caller's words and the reply.
      heardSilenceMs: 2421,
      carrierRoundTripMs: null,
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
      // The silence after the filler.
      heardSilenceMs: 846,
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

describe('call 8cb76efc F2: the silence the caller heard (Wave 12)', () => {
  const call7 = JSON.parse(
    readFileSync(new URL('./fixtures/call7-reply-waits.json', import.meta.url), 'utf8'),
  ) as { events: EngineEvent[] };

  it('turn 20: 11.8 s to "Sure. In Zagreb…", of which 2.3 s was silence after the answer it queued behind', () => {
    // "Please." was queued behind the reply to "Yeah, for both these places." (queueMs 9538): the
    // caller heard that reply play out, "Want to hear more?", and then 2.3 s of silence.
    const [turn19, turn20] = waits(call7.events);
    expect(turn19).toMatchObject({
      turnId: 'turn-19',
      firstAudioMs: 4267,
      fillerAudioMs: 3286,
      // The search line ("Let me look that up.") was cut for the answer 146 ms before it played.
      heardSilenceMs: 146,
    });
    expect(turn20).toMatchObject({
      turnId: 'turn-20',
      firstAudioMs: 11849,
      queueMs: 9538,
      composeMs: 2167,
      heardSilenceMs: 2309,
    });
    expect(parts(turn20!)).toBe(turn20!.firstAudioMs);
  });
});

describe('stages of a call asked ahead of its turn (Wave 10, B2)', () => {
  it('count on the turn once the engine reports it, though they settled before', () => {
    // The LLM is asked on the caller's final words while the turn still waits out their silence:
    // its first token can come before the turn stops, when the collector has no such turn yet.
    let turn: { llmFirstTokenMs: number | null; llmCalls: number } | undefined;
    const turns = new WorkerTurnTelemetry({
      includeText: false,
      emit: (summary) => (turn = summary),
    });
    turns.stage({
      stage: 'llm_first_token',
      turnId: 'turn-8',
      durationMs: 420,
      outcome: 'succeeded',
    });
    turns.engine({ type: 'user.turn', phase: 'started', turnId: 'turn-8', atMs: 0 } as EngineEvent);
    turns.engine({
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'turn-8',
      input: 'speech',
      text: 'Madras.',
      atMs: 250,
    } as EngineEvent);
    turns.stage({ stage: 'inference', turnId: 'turn-8', durationMs: 1300, outcome: 'succeeded' });
    turns.flush();
    expect(turn).toMatchObject({ turnId: 'turn-8', llmFirstTokenMs: 420, llmCalls: 1 });
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
