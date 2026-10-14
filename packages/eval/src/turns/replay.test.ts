import { describe, expect, it } from 'vitest';
import type { EndOfTurnModel } from '../../../plugin-turns/src/index.ts';
import { RULES, RULES_NO_HOLDS, runBakeoff } from './bakeoff.ts';
import { replayCall } from './replay.ts';
import type { Timeline } from './timeline.ts';

/** A caller who pauses 900 ms mid-sentence after a final the STT closed with a full stop. */
const PAUSED: Timeline = {
  call: 'test',
  label: 'test',
  durationMs: 20_000,
  transcripts: [
    { at: 1800, type: 'transcript', seg: '0', text: 'We are going to Budapest', final: false },
    {
      at: 2500,
      type: 'transcript',
      seg: '0',
      text: 'We are going to Budapest, Vienna.',
      final: true,
    },
    { at: 4300, type: 'transcript', seg: '1', text: 'And Zagreb.', final: true },
  ],
  agent: [{ start: 0, stop: 800, kind: 'response', text: 'Where to?', state: 'completed' }],
  live: [],
  vad: {
    source: 'modelled',
    events: [
      { at: 1000, type: 'vad.start' },
      { at: 2300, type: 'vad.stop' },
      { at: 3200, type: 'vad.start' },
      { at: 4000, type: 'vad.stop' },
    ],
  },
};

const model = (probability: (text: string) => number): EndOfTurnModel & { timings: number[] } => ({
  name: 'fake',
  input: 'text',
  timings: [],
  threshold: () => 0.5,
  predict: async ({ text }) => probability(text),
});

describe('turn replay', () => {
  it('replays a call through the rules: a complete-looking pause ends the turn early', async () => {
    const result = await replayCall(PAUSED, { name: 'rules', row: RULES });
    expect(result.endpoints.map((e) => e.text)).toEqual([
      'We are going to Budapest, Vienna.',
      'And Zagreb.',
    ]);
    expect(result.endpoints[0]!.at).toBeLessThan(3200);
  });

  it('replays it through the model gate: held in the pause, one turn with all the words', async () => {
    const reads = model((text) => (text.endsWith('Zagreb.') ? 0.9 : 0.1));
    const result = await replayCall(PAUSED, {
      name: 'model',
      row: { ...RULES_NO_HOLDS, model: {} },
      model: reads,
    });
    expect(result.endpoints.map((e) => e.text)).toEqual([
      'We are going to Budapest, Vienna. And Zagreb.',
    ]);
    expect(result.stats).toMatchObject({ merged: 1, held: ['We are going to Budapest, Vienna.'] });
  });
});

/**
 * The offline subset (no audio, no models, no network): calls 4 to 8 replayed through the rules
 * with the VAD modelled from their live turns. A change to the detector or the scorer that moves
 * these numbers shows here first; docs/eval/turn-bakeoff.md has the audio-VAD numbers.
 */
describe('turn bake-off, offline subset', () => {
  it('scores the corpus through the production rules', async () => {
    const result = await runBakeoff({ corpusDir: '/nonexistent', models: [] });
    const row = (variant: string) => {
      const { thoughts, endpoints, falseEndpoints, missed, p50, p90 } = result.summary.find(
        (s) => s.variant === variant,
      )!.score;
      return { thoughts, endpoints, falseEndpoints, missed, p50, p90 };
    };
    expect(result.calls.map((run) => run.vad)).toEqual(Array(5).fill('modelled'));
    expect({ live: row('live'), rules: row('rules'), noHolds: row('rules-noholds') }).toEqual(
      OFFLINE,
    );
  });
});

const OFFLINE = {
  live: { thoughts: 64, endpoints: 93, falseEndpoints: 29, missed: 1, p50: 753, p90: 1827 },
  rules: { thoughts: 64, endpoints: 92, falseEndpoints: 32, missed: 5, p50: 694, p90: 1019 },
  noHolds: { thoughts: 64, endpoints: 106, falseEndpoints: 37, missed: 1, p50: 614, p90: 843 },
};
