/**
 * Stateful rational resampler (#27a): a Kaiser-windowed sinc prototype split into L polyphase
 * branches, decimated by M. Every output sample is computed from the same inputs in the same order
 * however the stream is chunked, so chunked output is bit-identical.
 *
 * The prototype length is DERIVED from the requested stop-band attenuation and the transition
 * width (Kaiser's estimate), not fixed per phase. A fixed taps-per-phase understates pure
 * decimation: 24k→8k (L=1, M=3) then gets the same 48 total taps as an interpolating path gets per
 * phase, which leaves the stop band starting above the output Nyquist frequency and folds 4.0-4.6
 * kHz back into speech at only ~20-30 dB down. That is audible on sibilants over an 8 kHz carrier.
 */

export const RESAMPLER_RATES = [8000, 16000, 24000, 48000] as const;

/** Pass band runs to this fraction of the lower Nyquist; the stop band starts at Nyquist. */
const PASSBAND_EDGE = 0.85;
/** Designed stop-band attenuation. The gate for every supported pair is 60 dB. */
const STOPBAND_DB = 75;
/** Guard against pathological designs; no supported pair comes close. */
const MAX_PROTOTYPE_TAPS = 4096;

export interface ResamplerOptions {
  /** Overrides the derived length. Prefer `stopbandDb`; this exists for regression fixtures. */
  tapsPerPhase?: number;
  beta?: number;
  /** -6 dB point as a fraction of the lower Nyquist frequency. */
  cutoff?: number;
  /** Designed stop-band attenuation in dB; drives the Kaiser β and the prototype length. */
  stopbandDb?: number;
  /** A gap longer than this between pushes starts a fresh stream (history cleared). */
  clearAfterIdleMs?: number;
  now?: () => number;
}

/** Kaiser β for a given stop-band attenuation (Kaiser 1974). */
export function kaiserBeta(attenuationDb: number): number {
  if (attenuationDb > 50) return 0.1102 * (attenuationDb - 8.7);
  if (attenuationDb >= 21)
    return 0.5842 * Math.pow(attenuationDb - 21, 0.4) + 0.07886 * (attenuationDb - 21);
  return 0;
}

/** Kaiser's length estimate for a transition width given in cycles per sample. */
export function kaiserTaps(attenuationDb: number, transitionCyclesPerSample: number): number {
  const width = 2 * Math.PI * transitionCyclesPerSample;
  return Math.max(3, Math.ceil((attenuationDb - 8) / (2.285 * width)));
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function canResample(from: number, to: number): boolean {
  const rates: readonly number[] = RESAMPLER_RATES;
  return rates.includes(from) && rates.includes(to);
}

/** Zeroth-order modified Bessel function of the first kind (series). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 64; k += 1) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** Low-pass prototype at the upsampled rate, normalised so each phase has unity DC gain. */
export function designPrototype(
  upFactor: number,
  cutoffCyclesPerSample: number,
  taps: number,
  beta: number,
): Float64Array {
  const h = new Float64Array(taps);
  const centre = (taps - 1) / 2;
  const i0Beta = besselI0(beta);
  let sum = 0;
  for (let k = 0; k < taps; k += 1) {
    const x = k - centre;
    const arg = 2 * cutoffCyclesPerSample * x;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
    const ratio = (2 * k) / (taps - 1) - 1;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0Beta;
    h[k] = 2 * cutoffCyclesPerSample * sinc * window;
    sum += h[k]!;
  }
  for (let k = 0; k < taps; k += 1) h[k] = (h[k]! * upFactor) / sum;
  return h;
}

export class PolyphaseResampler {
  readonly up: number;
  readonly down: number;
  private readonly taps: number;
  private readonly phases: Float64Array[];
  private readonly idleMs: number;
  private readonly now: () => number;
  private history: Float64Array;
  private position = 0;
  private lastPush?: number;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
    options: ResamplerOptions = {},
  ) {
    if (!canResample(fromRate, toRate))
      throw new RangeError(`Unsupported resampling ratio ${fromRate} → ${toRate}`);
    const divisor = gcd(fromRate, toRate);
    this.up = toRate / divisor;
    this.down = fromRate / divisor;
    const nyquist = Math.min(fromRate, toRate) / 2;
    const stopbandDb = options.stopbandDb ?? STOPBAND_DB;
    // Pass band to 0.85·Nyquist, stop band from Nyquist: nothing above the output Nyquist may fold
    // back into the band. The -6 dB point sits between them unless the caller overrides it.
    const passEdgeHz = PASSBAND_EDGE * nyquist;
    const cutoffHz =
      options.cutoff === undefined ? (passEdgeHz + nyquist) / 2 : options.cutoff * nyquist;
    const protoRate = fromRate * this.up;
    const derived = kaiserTaps(stopbandDb, (nyquist - passEdgeHz) / protoRate);
    // The prototype runs at the upsampled rate, so its length must be a whole number of phases.
    // Equal rates need no filter at all: a lowpass there would notch the top of the band.
    const prototypeTaps =
      fromRate === toRate
        ? 1
        : options.tapsPerPhase !== undefined
          ? options.tapsPerPhase * this.up
          : Math.min(MAX_PROTOTYPE_TAPS, Math.ceil(derived / this.up) * this.up);
    this.taps = prototypeTaps / this.up;
    const prototype =
      prototypeTaps === 1
        ? Float64Array.of(1)
        : designPrototype(
            this.up,
            cutoffHz / protoRate,
            prototypeTaps,
            options.beta ?? kaiserBeta(stopbandDb),
          );
    this.phases = Array.from({ length: this.up }, (_, phase) => {
      const branch = new Float64Array(this.taps);
      for (let i = 0; i < this.taps; i += 1) branch[i] = prototype[phase + i * this.up]!;
      return branch;
    });
    this.history = new Float64Array(this.taps - 1);
    this.idleMs = options.clearAfterIdleMs ?? 200;
    this.now = options.now ?? Date.now;
  }

  /** Prototype length actually in use (taps at the upsampled rate). */
  get prototypeTaps(): number {
    return this.taps * this.up;
  }

  /** Input samples of group delay. */
  get delaySamples(): number {
    return Math.ceil((this.taps * this.up - 1) / 2 / this.up);
  }

  reset(): void {
    this.history = new Float64Array(this.taps - 1);
    this.position = 0;
    this.lastPush = undefined;
  }

  push(input: Int16Array): Int16Array {
    const at = this.now();
    if (this.lastPush !== undefined && at - this.lastPush > this.idleMs) this.reset();
    this.lastPush = at;
    return this.process(input);
  }

  /**
   * Drains the whole filter tail and starts a fresh stream. Pushing only the group delay leaves
   * the rest of the history — real signal — unplayed at every utterance boundary.
   */
  flush(): Int16Array {
    const tail = this.process(new Int16Array(Math.max(this.taps - 1, this.delaySamples) + 1));
    this.reset();
    return tail;
  }

  private process(input: Int16Array): Int16Array {
    const keep = this.taps - 1;
    const work = new Float64Array(keep + input.length);
    work.set(this.history);
    for (let i = 0; i < input.length; i += 1) work[keep + i] = input[i]!;
    const limit = input.length * this.up;
    const out = new Int16Array(Math.max(0, Math.ceil((limit - this.position) / this.down)));
    let count = 0;
    let t = this.position;
    for (; t < limit; t += this.down) {
      const base = Math.floor(t / this.up) + keep;
      const branch = this.phases[t % this.up]!;
      let acc = 0;
      for (let i = 0; i < this.taps; i += 1) acc += branch[i]! * work[base - i]!;
      const rounded = Math.round(acc);
      out[count++] = rounded > 32767 ? 32767 : rounded < -32768 ? -32768 : rounded;
    }
    this.position = t - limit;
    this.history = work.slice(work.length - keep);
    return count === out.length ? out : out.slice(0, count);
  }
}
