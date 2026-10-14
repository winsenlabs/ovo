import { predict } from '@livekit/local-inference';
import { describe, expect, it } from 'vitest';
import { LIVEKIT_AUDIO, LiveKitAudioModel, LiveKitTextModel } from '../src/index.ts';

/** A 2 s 16 kHz test signal: a falling tone, then silence (deterministic, no fixture file). */
function signal(): Int16Array {
  return Int16Array.from({ length: 32_000 }, (_, n) =>
    n < 24_000 ? Math.round(6000 * Math.sin((2 * Math.PI * (300 - n / 200) * n) / 16_000)) : 0,
  );
}

describe('LiveKit turn-detector-v1-mini (audio, through inference.TurnDetector)', () => {
  it('predicts on the last 1.2 s of the turn, as the native model does on that window', async () => {
    const model = new LiveKitAudioModel();
    try {
      const audio = signal();
      const window = audio.subarray(audio.length - (LIVEKIT_AUDIO.windowMs * 16_000) / 1000);
      const probability = await model.predict({ audio, text: '', language: 'en' });
      expect(probability).toBeGreaterThanOrEqual(0);
      expect(probability).toBeLessThanOrEqual(1);
      expect(probability).toBeCloseTo(await predict(Int16Array.from(window)), 5);
      // A second turn is not polluted by the first one's audio (the stream is flushed).
      const second = await model.predict({ audio: window, text: '', language: 'en' });
      expect(second).toBeCloseTo(probability, 5);
      expect(model.timings.length).toBe(2);
    } finally {
      await model.dispose();
    }
  });

  it('uses LiveKit Agents’ per-language thresholds and covers Hindi', () => {
    const model = new LiveKitAudioModel();
    expect(model.threshold('hi-IN')).toBe(0.305);
    expect(model.threshold('en')).toBe(0.36);
    expect(model.threshold('ta')).toBeUndefined();
    void model.dispose();
  });

  it('needs the caller audio', async () => {
    const model = new LiveKitAudioModel();
    await expect(model.predict({ text: 'hello', language: 'en' })).rejects.toThrow(/audio/);
    await model.dispose();
  });
});

/** The text model's files are fetched (scripts/fetch-model.mjs) only where the bake-off runs. */
describe.skipIf(!process.env.OVO_TURN_LIVEKIT_TEXT)(
  'LiveKit v0.4.1-intl (text, deprecated)',
  () => {
    it('reads a sentence that trails off as less finished than a complete question', async () => {
      const model = await LiveKitTextModel.load();
      try {
        const open = await model.predict({ text: 'I want to go to', language: 'en' });
        const done = await model.predict({
          text: 'What is the capital of Croatia?',
          agentText: 'How can I help with your trip?',
          language: 'en',
        });
        expect(open).toBeLessThan(done);
        expect(model.threshold('hi')).toBeGreaterThan(0);
        expect(model.timings.length).toBe(2);
      } finally {
        await model.dispose();
      }
    });
  },
);
