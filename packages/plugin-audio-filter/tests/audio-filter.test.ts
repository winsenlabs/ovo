import { describe, expect, it } from 'vitest';
import { Cap, type AudioFilter } from '@winsendotai/ovo-contracts';
import { seededRandom, speechLikePcm16 } from '@winsendotai/ovo-conformance/drivers';
import { compose } from '@winsendotai/ovo-sdk';
import {
  AUDIO_FILTER_PLUGIN_ID,
  AudioFilterConfigSchema,
  PHONE_AUDIO_FILTER_CONFIG,
  TelephonyAudioFilter,
  telephonyAudioFilterPlugin,
} from '../src/index.ts';

const RATE = 8000;
const tone = (hz: number, ms: number, amplitude = 8000) =>
  Int16Array.from(
    { length: (RATE * ms) / 1000 },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE),
  );
const db = (pcm: ArrayLike<number>, from = 0, to = pcm.length) => {
  let power = 0;
  for (let i = from; i < to; i++) power += pcm[i]! * pcm[i]!;
  return 10 * Math.log10(power / (to - from) + 1e-9);
};
/** Runs `pcm` through a fresh filter in 20 ms carrier frames, as the ingress would. */
function filtered(pcm: Int16Array, row: Record<string, unknown> = {}): Int16Array {
  const filter = new TelephonyAudioFilter(AudioFilterConfigSchema.parse(row));
  filter.start(RATE);
  const out = new Int16Array(pcm.length);
  for (let at = 0; at < pcm.length; at += 160)
    out.set(filter.filter(pcm.subarray(at, at + 160)), at);
  filter.stop();
  return out;
}
/** Level change in dB over the last half of the signal, after the filter has settled. */
const gainDb = (pcm: Int16Array, row: Record<string, unknown> = {}) =>
  db(filtered(pcm, row), pcm.length / 2) - db(pcm, pcm.length / 2);

describe('telephony audio filter', () => {
  it('takes rumble and vibration thumps out and leaves the speech band alone', () => {
    expect(gainDb(tone(40, 1000))).toBeLessThan(-30);
    expect(gainDb(tone(50, 1000))).toBeLessThan(-24);
    expect(gainDb(tone(70, 1000), { hum: null })).toBeLessThan(-10);
    expect(Math.abs(gainDb(tone(300, 1000)))).toBeLessThan(0.3);
    expect(Math.abs(gainDb(tone(1000, 1000)))).toBeLessThan(0.1);
    expect(Math.abs(gainDb(tone(3000, 1000)))).toBeLessThan(0.1);
  });

  it('notches mains hum harmonics the high-pass lets through', () => {
    // 150 Hz (the 3rd harmonic) is above the high-pass corner: only the notch removes it.
    expect(gainDb(tone(150, 2000))).toBeLessThan(-25);
    expect(gainDb(tone(150, 2000), { hum: null })).toBeGreaterThan(-1);
    expect(gainDb(tone(180, 2000), { hum: { mainsHz: 60, harmonics: 3 } })).toBeLessThan(-25);
    // Voice between the notches keeps its level.
    expect(Math.abs(gainDb(tone(175, 2000)))).toBeLessThan(1);
  });

  it('changes voiced speech by under 1 dB with the default (phone) row', () => {
    const speech = speechLikePcm16({ seed: 4, ms: 2000, rate: RATE });
    expect(Math.abs(gainDb(speech))).toBeLessThan(1);
  });

  it('is continuous across frames: 20 ms frames match one long call', () => {
    const speech = speechLikePcm16({ seed: 5, ms: 600, rate: RATE });
    const whole = new TelephonyAudioFilter(PHONE_AUDIO_FILTER_CONFIG);
    whole.start(RATE);
    expect(filtered(speech)).toEqual(whole.filter(speech));
  });

  it('the opt-in gate turns steady noise down between words and passes the words', () => {
    const random = seededRandom(3);
    const noise = () => (random() - 0.5) * 2 * 32768 * 10 ** (-50 / 20) * Math.sqrt(3);
    const word = speechLikePcm16({ seed: 6, ms: 400, rate: RATE });
    // 1 s of noise, a 400 ms word, 1 s of noise.
    const pcm = Int16Array.from({ length: 19200 }, (_, i) =>
      Math.round(noise() + (i >= 8000 && i < 11200 ? word[i - 8000]! : 0)),
    );
    // Compared with the same row without the gate, so only the gate's own effect is measured.
    const open = filtered(pcm);
    const out = filtered(pcm, { gate: { rangeDb: 12 } });
    // Once the 200 ms hold and 150 ms release have run, the noise is down by the range.
    expect(db(out, 17600, 19200) - db(open, 17600, 19200)).toBeLessThan(-11);
    // The word passes: within 1 dB over its first 20 ms, within 0.3 dB over all of it.
    expect(db(out, 8000, 8160) - db(open, 8000, 8160)).toBeGreaterThan(-1);
    expect(db(out, 8000, 11200) - db(open, 8000, 11200)).toBeGreaterThan(-0.3);
    // Without the gate the noise keeps its level.
    expect(db(open, 14400, 19200) - db(pcm, 14400, 19200)).toBeGreaterThan(-1);
  });

  it('the gate holds open across a short pause inside a sentence', () => {
    const word = speechLikePcm16({ seed: 7, ms: 300, rate: RATE });
    const pcm = new Int16Array(RATE);
    pcm.set(word, 0);
    pcm.set(word, 2400 + 1200); // a 150 ms gap
    const random = seededRandom(8);
    for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! + Math.round((random() - 0.5) * 20);
    const out = filtered(pcm, { gate: {} });
    // The second word's first 10 ms is not faded in.
    expect(db(out, 3600, 3680) - db(filtered(pcm), 3600, 3680)).toBeGreaterThan(-0.5);
  });

  it('is the session audio filter capability, with the phone row as its defaults', async () => {
    expect(AudioFilterConfigSchema.parse({})).toEqual(PHONE_AUDIO_FILTER_CONFIG);
    const graph = await compose([{ id: AUDIO_FILTER_PLUGIN_ID }], [telephonyAudioFilterPlugin]);
    try {
      const filter = graph.ctx.get(Cap.audioFilter) as AudioFilter;
      filter.start(RATE);
      expect(filter.filter(new Int16Array(160))).toEqual(new Int16Array(160));
      filter.stop();
    } finally {
      await graph.dispose();
    }
    await expect(
      compose(
        [{ id: AUDIO_FILTER_PLUGIN_ID, config: { highPassHz: 5000 } }],
        [telephonyAudioFilterPlugin],
      ),
    ).rejects.toThrow('Invalid config');
  });
});
