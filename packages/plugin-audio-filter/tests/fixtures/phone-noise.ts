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

/** Sound scaled to unit RMS, so the parts of a scene mix at the levels given. */
function unit(samples: Float64Array): Float64Array {
  const level = rms(samples);
  if (level > 0) for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! / level;
  return samples;
}

/**
 * A crowd: `count` other lines at once, each sped up or slowed down (0.8x to 1.25x, so each has
 * its own pitch) and started at its own point, until no one voice can be followed.
 */
function crowd(length: number, seed: number, speech: readonly Int16Array[], count: number) {
  const random = seededRandom(seed);
  const out = new Float64Array(length);
  for (let k = 0; k < count; k++) {
    const other = speech[(seed + k) % speech.length]!;
    const speed = 0.8 + random() * 0.45;
    const offset = Math.floor(random() * other.length);
    for (let i = 0; i < length; i++) {
      const at = offset + i * speed;
      const from = Math.floor(at);
      const a = other[from % other.length]!;
      const b = other[(from + 1) % other.length]!;
      out[i]! += a + (b - a) * (at - from);
    }
  }
  return unit(out);
}

/** Babble: eight voices of a busy room, none intelligible. */
const babble: Noise = (length, seed, speech) => crowd(length, seed, speech, 8);

/**
 * A cafe: six voices a little way off (low-passed), cups and cutlery (short bright clicks every
 * 0.3 to 1.5 s) and the espresso machine's steam (two-second hiss every ~6 s).
 */
const cafe: Noise = (length, seed, speech) => {
  const random = seededRandom(seed + 100);
  const out = lowPass(crowd(length, seed, speech, 6), 2500);
  unit(out);
  for (let at = Math.floor(random() * 4000); at < length; at += 2400 + Math.floor(random() * 9600))
    for (let i = 0, last = 0; i < 320 && at + i < length; i++) {
      // Differenced noise is bright: a clink rather than a thud.
      const sample = random() - 0.5;
      out[at + i]! += 6 * Math.exp(-i / 60) * (sample - last);
      last = sample;
    }
  for (
    let at = Math.floor(random() * 24000);
    at < length;
    at += 40000 + Math.floor(random() * 16000)
  )
    for (let i = 0, last = 0; i < 16000 && at + i < length; i++) {
      const sample = random() - 0.5;
      out[at + i]! += 0.8 * Math.sin((Math.PI * i) / 16000) * (sample - last);
      last = sample;
    }
  return out;
};

/**
 * A street: traffic rumble that swells as each vehicle passes (every 2 to 4 s), an engine's
 * 90 Hz drone with its harmonics, and a horn (420 and 520 Hz, 300 ms) every ~5 s.
 */
const street: Noise = (length, seed) => {
  const random = seededRandom(seed + 200);
  const out = unit(
    lowPass(
      lowPass(
        Float64Array.from({ length }, () => random() - 0.5),
        300,
      ),
      300,
    ),
  );
  const passes: number[] = [];
  for (
    let at = Math.floor(random() * 8000);
    at < length;
    at += 16000 + Math.floor(random() * 16000)
  )
    passes.push(at);
  for (let i = 0; i < length; i++) {
    const swell = passes.reduce((sum, at) => sum + Math.exp(-(((i - at) / 6000) ** 2)), 0.3);
    const drone = [1, 0.5, 0.3].reduce(
      (sum, gain, k) => sum + gain * Math.sin((2 * Math.PI * 90 * (k + 1) * i) / RATE),
      0,
    );
    out[i] = out[i]! * swell + 0.4 * swell * drone;
  }
  for (let at = 4000 + Math.floor(random() * 16000); at < length; at += 40000)
    for (let i = 0; i < 2400 && at + i < length; i++)
      out[at + i]! +=
        1.5 *
        (Math.sign(Math.sin((2 * Math.PI * 420 * i) / RATE)) +
          Math.sign(Math.sin((2 * Math.PI * 520 * i) / RATE)));
  return out;
};

/** Each phone-line condition and the speech-to-noise ratio it is mixed at. */
export const CONDITIONS = {
  clean: undefined,
  rumble: { noise: rumble, snrDb: -5 },
  hum: { noise: hum, snrDb: 0 },
  vibration: { noise: vibration, snrDb: 5 },
  steady: { noise: steady, snrDb: 10 },
  talkers: { noise: talkers, snrDb: 10 },
  beeps: { noise: beeps, snrDb: 5 },
  // Wave 8, from a live call in a noisy cafe (call 6e1a4e3a): the places callers ring from.
  cafe: { noise: cafe, snrDb: 5 },
  babble: { noise: babble, snrDb: 5 },
  street: { noise: street, snrDb: 0 },
} as const satisfies Record<string, { noise: Noise; snrDb: number } | undefined>;
export type Condition = keyof typeof CONDITIONS;

/**
 * Each noisy condition is mixed this many times per clip, each take with its own noise, so a
 * comparison rests on 363 words rather than 121 and one lucky word moves it less.
 */
export const TAKES = 3;

const preset = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../docs/presets/audio-filter/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as { config: Record<string, unknown> };

/**
 * The filter rows compared: none, the presets in `docs/presets/audio-filter/`, and the phone
 * preset with every stage on from the first frame (`engage: 'always'`, the Wave 7 behaviour).
 */
export const FILTERS = {
  off: undefined,
  telephony: preset('telephony'),
  'telephony-noisy': preset('telephony-noisy'),
  always: { config: { ...preset('telephony').config, engage: 'always' } },
} as const;
export type FilterName = keyof typeof FILTERS;

/** `clip` as the line delivers it under `condition`, in `take`: mu-law, as the carrier sends it. */
export function noisy(clipIndex: number, condition: Condition, take = 0): Uint8Array {
  const clip = SPEECH[clipIndex]!;
  const spec = CONDITIONS[condition];
  if (!spec) return clip.mulaw;
  const speech = mulawToPcm16(clip.mulaw);
  const others = SPEECH.map((other) => mulawToPcm16(other.mulaw)).filter((_, i) => i !== clipIndex);
  const seed = clipIndex + 1 + 1000 * take;
  return pcm16ToMulaw(mix(speech, spec.noise(speech.length, seed, others), spec.snrDb));
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
