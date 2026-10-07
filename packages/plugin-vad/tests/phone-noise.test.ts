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

/**
 * Connected voiced speech at `db` dBFS RMS: a jittered 110–190 Hz glottal pulse train with breath
 * noise through three formant resonators, a new vowel every 220 ms and a 4.5 Hz syllable envelope
 * dipping by `depth`. Its prediction gain (median 17 dB, max 21) matches real 8 kHz speech.
 */
function voice(ms: number, db: number, seed = 1, depth = 0.4): Part {
  const random = seededRandom(seed);
  const pitch = 110 + random() * 80;
  const samples = new Float64Array(Math.round((RATE * ms) / 1000));
  const state = new Float64Array(6);
  let vowel: readonly number[] = VOWELS[0];
  let pulseAt = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    if (i % 1760 === 0) vowel = VOWELS[Math.floor(random() * VOWELS.length)]!;
    let value = (random() - 0.5) * 0.15;
    if (i >= pulseAt) {
      value += 1;
      const hz = pitch * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t));
      pulseAt = i + Math.round((RATE / hz) * (1 + (random() - 0.5) * 0.04));
    }
    for (let k = 0; k < 3; k++) {
      const radius = Math.exp((-Math.PI * (90 + 40 * k)) / RATE);
      const coefficient = 2 * radius * Math.cos((2 * Math.PI * vowel[k]!) / RATE);
      const next = value + coefficient * state[2 * k]! - radius * radius * state[2 * k + 1]!;
      state[2 * k + 1] = state[2 * k]!;
      state[2 * k] = next;
      value = next * (1 - radius);
    }
    samples[i] = value * (1 - depth + depth * Math.sin(2 * Math.PI * 4.5 * t));
  }
  const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  const scale = dbToAmplitude(db) / rms;
  return { ms, at: (i) => samples[i]! * scale };
}
const silence = (ms: number): Part => ({ ms, at: () => 0 });
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

  it('P2: a soft trailing stretch below minVolume does not end the utterance', () => {
    // -38 dBFS is under minVolume's -32.5 dBFS but 20 dB over the line noise.
    const pcm = call([silence(400), voice(1200, -20), voice(600, -38, 2), silence(600)], -60);
    const list = transitions(pcm);
    expect(list.map((t) => t.type)).toEqual(['vad.start', 'vad.stop']);
    expect(list[1]!.atMs).toBeGreaterThanOrEqual(2200);
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
    expect(starts(transitions(pcm, { highPassHz: 0, rejectTones: false })).length).toBe(1);
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

  // minVolume is lowered so only the caller gate, not absolute level, decides these. The learned
  // level is the mean frame level, about 8 dB under the caller's RMS.
  const gated = { minVolume: 0.3 };

  it('a TV or a crowd from the first frame is learned as floor as fast as before', () => {
    // Four talkers at once, -32 dBFS from the moment the call connects, then the caller.
    const crowd: Part[] = [1, 2, 3, 4].map((seed) => voice(6000, -38, 20 + seed, 0.5));
    const babble: Part = { ms: 6000, at: (i, t) => crowd.reduce((sum, p) => sum + p.at(i, t), 0) };
    const list = transitions(call([babble, voice(1500, -14, 9), silence(600)], -60));
    const speaking = list.reduce(
      (sum, t, i) => (t.type === 'vad.start' ? sum + ((list[i + 1]?.atMs ?? 8100) - t.atMs) : sum),
      0,
    );
    // The crowd holds the VAD open only until the floor reaches it, as with the 2 s rise alone.
    const before = transitions(call([babble, voice(1500, -14, 9), silence(600)], -60), {
      speechFloorTauMs: 2000,
    });
    expect(list).toEqual(before);
    expect(speaking).toBeLessThan(5000);
  });

  it('a background talker 24 dB below the caller does not start speech', () => {
    const caller = (seed: number) => voice(1500, -16, seed);
    const pcm = call(
      [silence(300), caller(1), silence(700), voice(1200, -40, 7), silence(700), caller(3)],
      -64,
    );
    // The caller's two utterances, and nothing for the talker across the room in between.
    expect(starts(transitions(pcm, gated)).map((t) => Math.round(t.atMs / 1000))).toEqual([0, 5]);
    expect(starts(transitions(pcm, { ...gated, callerGateDb: null })).length).toBe(3);
  });

  it('the gate needs a second of caller speech: after a short "haan" a quieter voice still starts', () => {
    const parts = (callerMs: number) => [
      silence(300),
      voice(callerMs, -12),
      silence(700),
      voice(1000, -38, 7),
      silence(500),
    ];
    // 26 dB below the caller: admitted after 600 ms of caller speech, gated after 1500 ms.
    expect(starts(transitions(call(parts(600), -66), gated)).length).toBe(2);
    expect(starts(transitions(call(parts(1500), -66), gated)).length).toBe(1);
  });

  it('the gate only blocks starts: the caller dropping 24 dB mid-utterance is not cut off', () => {
    const pcm = call([silence(300), voice(1500, -16), voice(1000, -40, 2), silence(600)], -64);
    const list = transitions(pcm, gated);
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
      callerGateDb: 20,
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
