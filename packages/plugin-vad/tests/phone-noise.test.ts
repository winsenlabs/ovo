import { describe, expect, it } from 'vitest';
import { mulawToPcm16, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import { seededRandom } from '@winsendotai/ovo-conformance/drivers';
import { createEnergyVad, PHONE_VAD_CONFIG } from '../src/index.ts';
import { predictionGainDb } from '../src/tonality.ts';
import { VadState, type VadTransition } from '../src/vad-state.ts';

const RATE = 8000;
const dbToAmplitude = (db: number) => 32768 * 10 ** (db / 20);

/** A segment of the synthetic call: a generator for its samples, `ms` long. */
type Part = { ms: number; at: (i: number, t: number) => number };

/** Vowels as their first three formants (Hz), for the synthetic voice. */
const VOWELS = [
  [700, 1200, 2600],
  [300, 2200, 3000],
  [500, 900, 2400],
  [400, 1900, 2600],
  [600, 1000, 2500],
] as const;

/** One vowel held without a syllable rhythm ("aaaa", "mmm"): pitch, jitter, 5 Hz vibrato, F1. */
type Held = { pitch: number; jitter: number; vibrato: number; f1: number };

/**
 * Connected voiced speech at `db` dBFS RMS: a jittered 110–190 Hz glottal pulse train with breath
 * noise through three formant resonators, a new vowel every 220 ms and a 4.5 Hz syllable envelope
 * dipping by `depth`. Its prediction gain (median 17 dB, max 21) matches real 8 kHz speech. With
 * `held`, one steady vowel instead.
 */
function voice(ms: number, db: number, seed = 1, depth = 0.4, held?: Held): Part {
  const random = seededRandom(seed);
  const pitch = held?.pitch ?? 110 + random() * 80;
  const samples = new Float64Array(Math.round((RATE * ms) / 1000));
  const state = new Float64Array(6);
  let vowel: readonly number[] = held ? [held.f1, 1200, 2600] : VOWELS[0];
  let pulseAt = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    if (!held && i % 1760 === 0) vowel = VOWELS[Math.floor(random() * VOWELS.length)]!;
    let value = (random() - 0.5) * 0.15;
    if (i >= pulseAt) {
      value += 1;
      const hz = held
        ? pitch * (1 + held.vibrato * Math.sin(2 * Math.PI * 5 * t))
        : pitch * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t));
      const jitter = held ? held.jitter * 2 : 0.04;
      pulseAt = i + Math.round((RATE / hz) * (1 + (random() - 0.5) * jitter));
    }
    for (let k = 0; k < 3; k++) {
      const radius = Math.exp((-Math.PI * (90 + 40 * k)) / RATE);
      const coefficient = 2 * radius * Math.cos((2 * Math.PI * vowel[k]!) / RATE);
      const next = value + coefficient * state[2 * k]! - radius * radius * state[2 * k + 1]!;
      state[2 * k + 1] = state[2 * k]!;
      state[2 * k] = next;
      value = next * (1 - radius);
    }
    samples[i] = held ? value : value * (1 - depth + depth * Math.sin(2 * Math.PI * 4.5 * t));
  }
  const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  const scale = dbToAmplitude(db) / rms;
  return { ms, at: (i) => samples[i]! * scale };
}
const silence = (ms: number): Part => ({ ms, at: () => 0 });
/** `parts` played together, each from its own offset (ms) into an `ms`-long segment. */
const layered = (ms: number, parts: readonly (readonly [number, Part])[]): Part => ({
  ms,
  at: (i) =>
    parts.reduce((sum, [from, part]) => {
      const j = i - Math.round((RATE * from) / 1000);
      return j >= 0 && j < Math.round((RATE * part.ms) / 1000) ? sum + part.at(j, j / RATE) : sum;
    }, 0),
});
/** Several talkers at once, `db` dBFS RMS together. */
const babble = (ms: number, db: number, talkers = 3, seed = 20): Part =>
  layered(
    ms,
    Array.from(
      { length: talkers },
      (_, k) => [0, voice(ms, db - 10 * Math.log10(talkers), seed + k, 0.5)] as const,
    ),
  );
const tones = (ms: number, db: number, ...freqs: number[]): Part => ({
  ms,
  at: (i) =>
    freqs.reduce((sum, f) => sum + dbToAmplitude(db) * Math.sin((2 * Math.PI * f * i) / RATE), 0),
});

/** Concatenates parts over `noiseDb` of white line noise, through the μ-law phone codec. */
function call(parts: readonly Part[], noiseDb = -60, seed = 5): Int16Array {
  const random = seededRandom(seed);
  const noise = dbToAmplitude(noiseDb) * Math.sqrt(3) * 2;
  const out: number[] = [];
  for (const part of parts) {
    const n = Math.round((RATE * part.ms) / 1000);
    for (let i = 0; i < n; i++) out.push(part.at(i, i / RATE) + (random() - 0.5) * noise);
  }
  const pcm = Int16Array.from(out, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
  return mulawToPcm16(pcm16ToMulaw(pcm));
}

function transitions(pcm: Int16Array, row: Record<string, unknown> = {}): VadTransition[] {
  const factory = createEnergyVad(row);
  const analyzer = factory.create(RATE);
  const state = new VadState(factory.params);
  const result: VadTransition[] = [];
  for (let at = 0; at + analyzer.frameSamples <= pcm.length; at += analyzer.frameSamples) {
    const frame = pcm.slice(at, at + analyzer.frameSamples);
    const transition = state.observe(analyzer.confidence(frame), analyzer.volume(frame));
    if (transition) result.push(transition);
  }
  return result;
}
const starts = (list: VadTransition[]) => list.filter((t) => t.type === 'vad.start');

describe('energy VAD on phone audio', () => {
  it('P2: a 5 s sentence keeps one utterance; the old 2 s floor rise cut it mid-sentence', () => {
    // Call B 13:06:32: "…You didn't go there and tell me for-" ended while the caller still spoke.
    // The line noise is heard for 3 s first, as it is while the agent's greeting plays.
    const pcm = call([silence(3000), voice(5000, -24), silence(800)], -52);
    const now = transitions(pcm);
    expect(now.map((t) => t.type)).toEqual(['vad.start', 'vad.stop']);
    expect(now[1]!.atMs).toBeGreaterThanOrEqual(8000);
    const before = transitions(pcm, { speechFloorTauMs: 2000 });
    expect(before.find((t) => t.type === 'vad.stop')!.atMs).toBeLessThan(8000);
  });

  it('P2: a quiet caller trailing off below minVolume is not cut short', () => {
    // A -24 dBFS caller ends on a -32 dBFS stretch: mostly under minVolume's -32.5 dBFS frame
    // level, but within the caller gate of their own learned level, so it is still the caller.
    const pcm = call([silence(400), voice(1600, -24, 9), voice(700, -32, 2), silence(600)], -60);
    const list = transitions(pcm);
    expect(list.map((t) => t.type)).toEqual(['vad.start', 'vad.stop']);
    expect(list[1]!.atMs).toBeGreaterThanOrEqual(2700);
  });

  it('review: babble 20 dB below the caller does not hold the utterance open after they stop', () => {
    // A quiet line, then a room of talkers at -40 dBFS from 1 s to 9 s; the -20 dBFS caller talks
    // from 4.0 to 5.5 s. The floor froze for the babble, and the minVolume hold kept every frame of
    // it in the utterance: the stop waited for the babble to end at 9.2 s.
    const pcm = call(
      [
        silence(1000),
        layered(8000, [
          [0, babble(8000, -40)],
          [3000, voice(1500, -20, 9)],
        ]),
        silence(1000),
      ],
      -60,
    );
    const stop = transitions(pcm).find((t) => t.type === 'vad.stop')!;
    expect(stop.atMs).toBeGreaterThan(5500);
    expect(stop.atMs).toBeLessThanOrEqual(5800);
    // One talker 16 dB below the caller, starting during them and going on after.
    const talker = call(
      [
        silence(4000),
        layered(4500, [
          [0, voice(1500, -20, 9)],
          [500, voice(4000, -36, 7)],
        ]),
        silence(500),
      ],
      -60,
    );
    const after = transitions(talker).find((t) => t.type === 'vad.stop')!;
    expect(after.atMs).toBeLessThanOrEqual(5900);
  });

  it('review: a held vowel inside an utterance does not stop it', () => {
    // An 800 ms "aaaa" at 200 Hz with little jitter predicts like a tone; rejected mid-utterance
    // it stopped the VAD and restarted it ~200 ms later, inside the commit wait.
    const held = { pitch: 200, jitter: 0.01, vibrato: 0.03, f1: 700 };
    const pcm = call(
      [
        silence(400),
        voice(1200, -22, 1),
        voice(800, -24, 3, 0, held),
        voice(1200, -22, 2),
        silence(600),
      ],
      -55,
    );
    expect(transitions(pcm).map((t) => t.type)).toEqual(['vad.start', 'vad.stop']);
  });

  it('a tone that goes on after the caller stops ends the utterance within 1.5 s', () => {
    const pcm = call([silence(400), voice(1500, -20, 9), tones(3000, -20, 400, 450), silence(400)]);
    const list = transitions(pcm);
    expect(list.map((t) => t.type)).toEqual(['vad.start', 'vad.stop']);
    expect(list[1]!.atMs).toBeLessThanOrEqual(1900 + 1500 + 300);
  });

  it('handling rumble and vibration thumps below the high-pass corner never start speech', () => {
    const random = seededRandom(9);
    // A phone handled or vibrating against a table: 80–110 Hz body modes swelling and decaying
    // 1.6 times a second at -26 dBFS, 34 dB over the line noise. The old analyzer counted anything
    // with three zero crossings a frame (75 Hz and up) at full weight.
    const modes = [80, 95, 110].map((hz) => ({ hz, phase: random() * 2 * Math.PI }));
    const rumble: Part = {
      ms: 3000,
      at: (i, t) =>
        dbToAmplitude(-26) *
        0.8 *
        (0.55 - 0.45 * Math.cos(2 * Math.PI * 1.6 * t)) *
        modes.reduce((sum, m) => sum + Math.sin((2 * Math.PI * m.hz * i) / RATE + m.phase), 0),
    };
    const pcm = call([silence(300), rumble, silence(300)]);
    expect(starts(transitions(pcm))).toEqual([]);
    // The high-pass alone rejects it; without it (and tone rejection) it was speech.
    expect(starts(transitions(pcm, { rejectTones: false }))).toEqual([]);
    expect(starts(transitions(pcm, { highPassHz: 0, rejectTones: false })).length).toBeGreaterThan(
      0,
    );
  });

  it('50 Hz mains hum with harmonics never starts speech', () => {
    const pcm = call([silence(200), tones(2000, -24, 50, 100, 150, 250), silence(200)]);
    expect(starts(transitions(pcm))).toEqual([]);
  });

  it.each([
    ['a held DTMF 5 (770 + 1336 Hz)', [770, 1336], -20, 400],
    ['a quieter DTMF 1 (697 + 1209 Hz)', [697, 1209], -30, 400],
    ['a 1 kHz network beep', [1000], -18, 500],
    ['a call-waiting 440 Hz beep', [440], -24, 300],
    ['Indian ring-back (400 + 450 Hz)', [400, 450], -22, 1000],
  ])('%s is not speech', (_, freqs, db, ms) => {
    const pcm = call([
      silence(300),
      tones(ms, db, ...freqs),
      silence(300),
      tones(ms, db, ...freqs),
    ]);
    expect(starts(transitions(pcm))).toEqual([]);
    expect(starts(transitions(pcm, { rejectTones: false })).length).toBeGreaterThan(0);
  });

  it('a vibrating phone (a steady 175 Hz buzz in 700 ms pulses) is not speech', () => {
    const buzz: Part = {
      ms: 700,
      at: (i) => dbToAmplitude(-22) * Math.sign(Math.sin((2 * Math.PI * 175 * i) / RATE)),
    };
    const pcm = call([silence(300), buzz, silence(400), buzz, silence(400), buzz]);
    expect(starts(transitions(pcm))).toEqual([]);
  });

  it('a TV or a crowd from the first frame is learned as floor as fast as before', () => {
    // Four talkers at once, -32 dBFS from the moment the call connects, then the caller.
    const crowd = babble(6000, -32, 4, 21);
    const list = transitions(call([crowd, voice(1500, -14, 9), silence(600)], -60));
    const speaking = list.reduce(
      (sum, t, i) => (t.type === 'vad.start' ? sum + ((list[i + 1]?.atMs ?? 8100) - t.atMs) : sum),
      0,
    );
    // The crowd holds the VAD open only until the floor reaches it, as with the 2 s rise alone.
    const before = transitions(call([crowd, voice(1500, -14, 9), silence(600)], -60), {
      speechFloorTauMs: 2000,
    });
    expect(list).toEqual(before);
    expect(speaking).toBeLessThan(5000);
  });

  // Default config throughout: the gate is measured against the caller's RMS level, and a -14 dBFS
  // caller is loud enough for minVolume alone to let a talker 12 dB below them through.
  const talkerAfter = (callerMs: number) => [
    silence(300),
    voice(callerMs, -14, 9),
    silence(700),
    voice(1200, -26, 7),
    silence(700),
    voice(1500, -14, 3),
  ];

  it('review: a talker 12 dB below the caller does not start speech at the default config', () => {
    const pcm = call(talkerAfter(2000), -60);
    // The caller's two utterances, and nothing for the talker across the room in between.
    expect(starts(transitions(pcm)).map((t) => Math.round(t.atMs / 1000))).toEqual([0, 5]);
    expect(starts(transitions(pcm, { callerGateDb: null })).length).toBe(3);
    // The caller's own next reply 8 dB softer than before still starts.
    const softer = call([silence(300), voice(2000, -14, 9), silence(1200), voice(1000, -22, 4)]);
    expect(starts(transitions(softer)).length).toBe(2);
  });

  it('the gate needs a second of caller speech: after a short "haan" a quieter voice still starts', () => {
    expect(starts(transitions(call(talkerAfter(600), -60))).length).toBe(3);
    expect(starts(transitions(call(talkerAfter(2000), -60))).length).toBe(2);
  });

  it('the gate only blocks starts: the caller dropping 16 dB mid-utterance is not cut off', () => {
    const pcm = call([silence(300), voice(1500, -8, 9), voice(1000, -24, 2), silence(600)], -64);
    const list = transitions(pcm);
    expect(list.map((t) => t.type)).toEqual(['vad.start', 'vad.stop']);
    expect(list[1]!.atMs).toBeGreaterThanOrEqual(2800);
  });

  it('the predictor separates μ-law tones from voiced speech', () => {
    const frame = (part: Part) => call([part]).subarray(800, 960);
    // 200 ms parts, so the frame lies inside them.
    expect(predictionGainDb(frame(tones(200, -20, 1000)))).toBeGreaterThan(32);
    expect(predictionGainDb(frame(tones(200, -20, 770, 1336)))).toBeGreaterThan(32);
    expect(predictionGainDb(frame(voice(200, -20)))).toBeLessThan(32);
    expect(predictionGainDb(new Int16Array(160))).toBe(0);
  });

  it('PHONE_VAD_CONFIG is the documented phone row and the factory keeps the §2.7 params', () => {
    expect(PHONE_VAD_CONFIG).toMatchObject({
      highPassHz: 200,
      speechFloorTauMs: 15000,
      rejectTones: true,
      callerGateDb: 12,
    });
    expect(Object.keys(createEnergyVad(PHONE_VAD_CONFIG).params).sort()).toEqual([
      'confidence',
      'minVolume',
      'smoothing',
      'startMs',
      'stopMs',
    ]);
  });
});
