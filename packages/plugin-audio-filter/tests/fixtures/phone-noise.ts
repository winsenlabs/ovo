import { readdirSync, readFileSync } from 'node:fs';
import { mulawToPcm16, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import { seededRandom } from '@winsendotai/ovo-conformance/drivers';
import { AudioFilterConfigSchema, TelephonyAudioFilter } from '../../src/index.ts';

const RATE = 8000;
const SPEECH_DIR = new URL('./phone-speech/', import.meta.url);

/**
 * Real 8 kHz mu-law speech: agent lines as the live CreditMantri calls played them (the release's
 * pre-rendered clips, ElevenLabs `ulaw_8000`). Callers' own audio was never recorded, so the noise
 * of a phone line is added on top, seeded and repeatable.
 */
export const SPEECH: ReadonlyArray<{ id: string; mulaw: Uint8Array }> = readdirSync(SPEECH_DIR)
  .filter((name) => name.endsWith('.ulaw'))
  .sort()
  .map((name) => ({
    id: name.replace(/\.ulaw$/, ''),
    mulaw: new Uint8Array(readFileSync(new URL(name, SPEECH_DIR))),
  }));

const rms = (pcm: ArrayLike<number>) => {
  let power = 0;
  for (let i = 0; i < pcm.length; i++) power += pcm[i]! * pcm[i]!;
  return Math.sqrt(power / Math.max(1, pcm.length));
};

/** `noise` scaled so speech sits `snrDb` above it over the whole clip, then mixed in. */
function mix(speech: Int16Array, noise: Float64Array, snrDb: number): Int16Array {
  const scale = rms(speech) / Math.max(1e-9, rms(noise)) / 10 ** (snrDb / 20);
  return Int16Array.from(speech, (sample, i) =>
    Math.max(-32768, Math.min(32767, Math.round(sample + noise[i]! * scale))),
  );
}

/** A one-pole low-pass, in place. */
function lowPass(samples: Float64Array, hz: number): Float64Array {
  const a = Math.exp((-2 * Math.PI * hz) / RATE);
  let state = 0;
  for (let i = 0; i < samples.length; i++) samples[i] = state = (1 - a) * samples[i]! + a * state;
  return samples;
}

type Noise = (length: number, seed: number, speech: readonly Int16Array[]) => Float64Array;

/** Handling rumble: brown noise below ~60 Hz with 25 Hz thumps, as a phone moved in the hand. */
const rumble: Noise = (length, seed) => {
  const random = seededRandom(seed);
  const out = lowPass(
    Float64Array.from({ length }, () => random() - 0.5),
    60,
  );
  for (let at = Math.floor(random() * 4000); at < length; at += 6000 + Math.floor(random() * 6000))
    for (let i = 0; i < 2400 && at + i < length; i++)
      out[at + i]! += 0.05 * Math.exp(-i / 600) * Math.sin((2 * Math.PI * 25 * i) / RATE);
  return out;
};

/** Mains hum: 50 Hz and its first four harmonics, as a charger or a cheap handset adds it. */
const hum: Noise = (length) =>
  Float64Array.from({ length }, (_, i) =>
    [1, 0.6, 0.4, 0.25, 0.15].reduce(
      (sum, gain, k) => sum + gain * Math.sin((2 * Math.PI * 50 * (k + 1) * i) / RATE),
      0,
    ),
  );

/** A phone vibrating on a table: a 175 Hz buzz, rich in harmonics, 400 ms on and 600 ms off. */
const vibration: Noise = (length) =>
  Float64Array.from({ length }, (_, i) =>
    i % 8000 < 3200 ? Math.sign(Math.sin((2 * Math.PI * 175 * i) / RATE)) : 0,
  );

/** Steady background noise (a fan, traffic): white noise tilted towards the low end. */
const steady: Noise = (length, seed) => {
  const random = seededRandom(seed);
  return lowPass(
    Float64Array.from({ length }, () => random() - 0.5),
    800,
  );
};

/** Background talkers: three other agent lines at once, as a room or a TV behind the caller. */
const talkers: Noise = (length, seed, speech) => {
  const out = new Float64Array(length);
  for (let k = 0; k < 3; k++) {
    const other = speech[(seed + k + 1) % speech.length]!;
    const offset = Math.floor(seededRandom(seed + k)() * other.length);
    for (let i = 0; i < length; i++) out[i]! += other[(offset + i) % other.length]!;
  }
  return out;
};

/** Network or keypad beeps: 1 kHz for 120 ms every 1.5 s. */
const beeps: Noise = (length) =>
  Float64Array.from({ length }, (_, i) =>
    i % 12000 < 960 ? Math.sin((2 * Math.PI * 1000 * i) / RATE) : 0,
  );

/** Each phone-line condition and the speech-to-noise ratio it is mixed at. */
export const CONDITIONS = {
  clean: undefined,
  rumble: { noise: rumble, snrDb: -5 },
  hum: { noise: hum, snrDb: 0 },
  vibration: { noise: vibration, snrDb: 5 },
  steady: { noise: steady, snrDb: 10 },
  talkers: { noise: talkers, snrDb: 10 },
  beeps: { noise: beeps, snrDb: 5 },
} as const satisfies Record<string, { noise: Noise; snrDb: number } | undefined>;
export type Condition = keyof typeof CONDITIONS;

/** The filter rows compared: none, then the presets in `docs/presets/audio-filter/`. */
export const FILTERS = {
  off: undefined,
  telephony: JSON.parse(
    readFileSync(
      new URL('../../../../docs/presets/audio-filter/telephony.json', import.meta.url),
      'utf8',
    ),
  ) as { config: Record<string, unknown> },
  'telephony-noisy': JSON.parse(
    readFileSync(
      new URL('../../../../docs/presets/audio-filter/telephony-noisy.json', import.meta.url),
      'utf8',
    ),
  ) as { config: Record<string, unknown> },
} as const;
export type FilterName = keyof typeof FILTERS;

/** `clip` as the line delivers it under `condition`: mu-law, as the carrier sends it. */
export function noisy(clipIndex: number, condition: Condition): Uint8Array {
  const clip = SPEECH[clipIndex]!;
  const spec = CONDITIONS[condition];
  if (!spec) return clip.mulaw;
  const speech = mulawToPcm16(clip.mulaw);
  const others = SPEECH.map((other) => mulawToPcm16(other.mulaw)).filter((_, i) => i !== clipIndex);
  return pcm16ToMulaw(mix(speech, spec.noise(speech.length, clipIndex + 1, others), spec.snrDb));
}

/** What the STT hears with `filter`: the engine's ingress, 20 ms carrier frames through it. */
export function heard(mulaw: Uint8Array, filter: FilterName): Uint8Array {
  const preset = FILTERS[filter];
  if (!preset) return mulaw;
  const audioFilter = new TelephonyAudioFilter(AudioFilterConfigSchema.parse(preset.config));
  audioFilter.start(RATE);
  const out = new Uint8Array(mulaw.length);
  for (let at = 0; at < mulaw.length; at += 160)
    out.set(pcm16ToMulaw(audioFilter.filter(mulawToPcm16(mulaw.subarray(at, at + 160)))), at);
  audioFilter.stop();
  return out;
}
