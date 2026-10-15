import { MULAW_8K, type SttEvent } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { MAYA } from '../src/corpus/profile.ts';
import {
  estimateOffset,
  reportedStarts,
  speakingAt,
  traceFromPcm,
  traceFromTurns,
} from '../src/corpus/vad-trace.ts';
import { chooseDetector } from '../src/replay/detectors.ts';
import { liveReplies, recordedResponder } from '../src/replay/responder.ts';
import { scribeModel } from '../src/replay/scribe-model.ts';
import { VirtualTime } from '../src/replay/virtual-time.ts';
import type { CallTimeline, Transcript } from '../src/timeline.ts';

const t = (atMs: number, segmentId: string, text: string, final = false): Transcript => ({
  atMs,
  segmentId,
  text,
  final,
});

async function scribe(live: Transcript[], commitsAt: number[], until = 10_000) {
  const clock = new VirtualTime(0);
  const events: string[] = [];
  const stt = scribeModel(clock, live, { commitLatencyMs: 300 });
  const session = await stt.start({
    sessionId: 's',
    format: MULAW_8K,
    language: 'en-IN',
    signal: new AbortController().signal,
    onEvent: (event: SttEvent) => {
      if (event.type === 'transcript')
        events.push(
          `${clock.callTime()} ${event.segment.stability} ${event.segment.segmentId} ${event.segment.text}`,
        );
      else events.push(`${clock.callTime()} ${event.type}`);
    },
    onUsage: () => undefined,
  });
  for (const at of commitsAt) clock.setTimeout(() => void session.forceEndpoint!(), at);
  await clock.runUntil(until);
  return events;
}

describe('the Scribe model of a transcript replay', () => {
  const live = [
    t(1000, '0', 'I want'),
    t(1800, '0', 'I want to go to Paris'),
    t(2600, '0', 'I want to go to Paris.', true),
  ];

  it('answers a commit the live call made with the live final, when it came', async () => {
    expect(await scribe(live, [2300])).toEqual([
      '1000 interim 0 I want',
      '1800 interim 0 I want to go to Paris',
      '2600 final 0 I want to go to Paris.',
      '2600 end-of-turn',
    ]);
  });

  it('answers a commit a little behind the live one with the final already in hand', async () => {
    expect((await scribe(live, [2650])).slice(-2)).toEqual([
      '2650 final 0 I want to go to Paris.',
      '2650 end-of-turn',
    ]);
  });

  it('models a commit the live call never made, and carries on with the rest', async () => {
    // Committed after "I want": Scribe answers 300 ms later with the words heard by then.
    expect(await scribe(live, [1200, 2300])).toEqual([
      '1000 interim 0 I want',
      '1500 final 0 I want',
      '1500 end-of-turn',
      '1800 interim 1 to go to Paris',
      '2600 final 1 to go to Paris.',
      '2600 end-of-turn',
    ]);
  });

  it('keeps a live final the replay did not commit as open words for the next commit', async () => {
    const two = [...live, t(4000, '1', 'In December.'), t(4500, '1', 'In December.', true)];
    expect(await scribe(two, [4200])).toEqual([
      '1000 interim 0 I want',
      '1800 interim 0 I want to go to Paris',
      '2600 interim 0 I want to go to Paris.',
      '4000 interim 0 I want to go to Paris. In December.',
      '4500 final 0 I want to go to Paris. In December.',
      '4500 end-of-turn',
    ]);
  });
});

describe('the recorded responder', () => {
  const timeline: CallTimeline = {
    turns: [
      {
        turnId: 'turn-1',
        startedAtMs: 0,
        endedAtMs: 2000,
        outcome: 'stopped',
        input: 'speech',
        text: 'Nothing. So we want to go to Budapest, Vienna.',
      },
      {
        turnId: 'turn-2',
        startedAtMs: 3000,
        endedAtMs: 4000,
        outcome: 'stopped',
        input: 'speech',
        text: 'Hungary, Zagreb, Croatia.',
      },
      {
        turnId: 'turn-3',
        startedAtMs: 9000,
        endedAtMs: 9500,
        outcome: 'stopped',
        input: 'speech',
        text: 'Thank you.',
      },
    ],
    agent: [
      {
        segmentId: 's1',
        epoch: 1,
        kind: 'response',
        text: 'Budapest and Vienna make a lovely pairing.',
        generatedAtMs: 3500,
        turnId: 'turn-1',
        outcome: 'interrupted',
      },
      {
        segmentId: 's2',
        epoch: 2,
        kind: 'acknowledgment',
        text: 'Let me look that up.',
        generatedAtMs: 4100,
        audibleAtMs: 4100,
        turnId: 'turn-2',
        outcome: 'completed',
      },
      {
        segmentId: 's3',
        epoch: 2,
        kind: 'response',
        text: 'A lovely Central European trip. Want more detail?',
        generatedAtMs: 7000,
        audibleAtMs: 7100,
        turnId: 'turn-2',
        outcome: 'completed',
      },
      {
        segmentId: 's4',
        epoch: 3,
        kind: 'response',
        text: 'Have a lovely trip, goodbye!',
        generatedAtMs: 10_500,
        turnId: 'turn-3',
        outcome: 'completed',
      },
    ],
    transcripts: [],
    llm: [
      { atMs: 1800, id: 'r1' },
      { atMs: 4000, id: 'r2' },
      { atMs: 9500, id: 'r3' },
    ],
    interrupts: [],
    durationMs: 12_000,
  };

  it('takes the model words off each live turn: offers and platform lines dropped, searches, timing', () => {
    expect(liveReplies(timeline, MAYA)).toEqual([
      {
        turnId: 'turn-1',
        caller: timeline.turns[0]!.text,
        text: 'Budapest and Vienna make a lovely pairing.',
        searched: false,
        latencyMs: 1700,
      },
      {
        turnId: 'turn-2',
        caller: 'Hungary, Zagreb, Croatia.',
        text: 'A lovely Central European trip.',
        searched: true,
        latencyMs: 3000,
      },
      {
        turnId: 'turn-3',
        caller: 'Thank you.',
        goodbye: 'Have a lovely trip, goodbye!',
        searched: false,
        latencyMs: 1000,
      },
    ]);
  });

  it('answers merged, partial and repeated requests with the right live turn, a goodbye only in order', async () => {
    const clock = new VirtualTime(0);
    const responder = recordedResponder(
      liveReplies(timeline, MAYA),
      MAYA,
      (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms)),
      () => clock.callTime(),
    );
    const ask = async (input: string) => {
      const out: string[] = [];
      const reading = (async () => {
        for await (const event of responder.stream!({
          input,
          signal: new AbortController().signal,
        } as never))
          out.push(
            event.kind === 'text-delta'
              ? event.delta
              : event.kind === 'tool'
                ? `[${event.toolId}]`
                : '',
          );
      })();
      await clock.runUntil(clock.callTime() + 5000);
      await reading;
      return out.join('');
    };
    // A request asked ahead on the caller's partial words.
    expect(await ask('Nothing. So we want')).toBe('Budapest and Vienna make a lovely pairing.');
    // The next turn merged with it (AGT-10): its newest words decide.
    expect(
      await ask('Nothing. So we want to go to Budapest, Vienna. Hungary, Zagreb, Croatia.'),
    ).toBe('A lovely Central European trip.');
    expect(await ask('Thank you.')).toBe('[end_call]');
    expect(responder.requests.map((r) => r.answeredBy)).toEqual(['turn-1', 'turn-2', 'turn-3']);
  });
});

describe('VAD traces', () => {
  // 1 s of a 440 Hz tone at -12 dBFS between 1 s and 2 s, silence around it (8 kHz).
  const samples = new Int16Array(8000 * 3);
  for (let i = 8000; i < 16_000; i++)
    samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000));

  it('reads where the energy VAD heard speech off the audio, and when it would report the start', () => {
    const trace = traceFromPcm({ sampleRate: 8000, samples }, 500, { rejectTones: false });
    expect(trace.runs.length).toBeGreaterThan(0);
    expect(trace.runs[0]![0]).toBeGreaterThanOrEqual(1000);
    expect(trace.runs[0]![0]).toBeLessThan(1100);
    expect(speakingAt(trace, 500 + 1500)).toBe(true);
    expect(speakingAt(trace, 500 + 2500)).toBe(false);
    // Reported after 200 ms of speech, at the end of the frame that completed it.
    expect(reportedStarts(trace)[0]).toBe(trace.runs[0]![0] + 200);
  });

  it('finds the track offset most turn starts agree on, ignoring the odd one out', () => {
    const trace = {
      source: 'audio' as const,
      offsetMs: 0,
      frameMs: 20,
      runs: [
        [1000, 2000],
        [5000, 6000],
        [9000, 9500],
        [12_000, 13_000],
      ] as [number, number][],
    };
    expect(estimateOffset(trace, [380, 4380, 8380, 15_000])).toEqual({
      offsetMs: -820,
      agreeing: 3,
    });
    expect(estimateOffset(trace, [380])).toBeNull();
  });

  it('models a trace from the turns when there is no audio', () => {
    const trace = traceFromTurns([
      { turnId: 'a', startedAtMs: 1200, endedAtMs: 3000, outcome: 'stopped', endpointMs: 500 },
      { turnId: 'b', startedAtMs: 2000, endedAtMs: 2600, outcome: 'reset' },
    ]);
    expect(trace).toEqual({ source: 'modelled', offsetMs: 0, frameMs: 20, runs: [[1000, 2600]] });
  });
});

describe('turn detectors and virtual time', () => {
  it('runs the default detector with idle prompts off, and a module detector by path', async () => {
    const rules = await chooseDetector('rules', MAYA.detector, { minWordsWhileBotSpeaking: 2 });
    expect(rules.row).toMatchObject({ idle: null, minWordsWhileBotSpeaking: 2 });
    const module = await chooseDetector(
      'module:packages/plugin-turns/src/index.ts#createTurnDetector',
      {},
    );
    expect(typeof module.factory.create).toBe('function');
    await expect(chooseDetector('magic', {})).rejects.toThrow(/unknown detector/);
  });

  it('routes the timer globals and Date.now through the replay clock while installed', async () => {
    const clock = new VirtualTime(1_000_000);
    const fired: number[] = [];
    clock.install();
    try {
      setTimeout(() => fired.push(Date.now()), 250);
      const every = setInterval(() => fired.push(clock.callTime()), 100);
      await clock.runUntil(320);
      clearInterval(every);
      await clock.runUntil(1000);
    } finally {
      clock.uninstall();
    }
    expect(fired).toEqual([100, 200, 1_000_250, 300]);
    expect(Date.now()).toBeGreaterThan(1_700_000_000_000);
  });
});
