/**
 * Whisper's log-mel features as Smart Turn computes them (transformers WhisperFeatureExtractor with
 * `chunk_length=8`, `do_normalize=True`, numpy path, checked against it in tests/features.test.ts):
 * 8 s of 16 kHz audio, zero-mean unit-variance normalised over the whole window, a centred
 * 400-point Hann STFT every 160 samples (reflect padding), the power spectrum through 80 Slaney mel
 * filters, log10 floored at 1e-10, the last frame dropped, clamped to 8 below the maximum and scaled
 * to (x + 4) / 4. Output: [80 mels x 800 frames], row-major.
 */
export const SAMPLE_RATE = 16_000;
export const WINDOW_SECONDS = 8;
export const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS;
export const N_MELS = 80;
const N_FFT = 400;
const HOP = 160;
const BINS = N_FFT / 2 + 1;
export const N_FRAMES = WINDOW_SAMPLES / HOP;

/** Slaney's mel scale, as librosa and transformers' `hertz_to_mel(mel_scale="slaney")`. */
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = 15;
const LOG_STEP = 27 / Math.log(6.4);
const hzToMel = (hz: number) =>
  hz >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) * LOG_STEP : (3 * hz) / 200;
const melToHz = (mel: number) =>
  mel >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp((mel - MIN_LOG_MEL) / LOG_STEP) : (200 * mel) / 3;

/** Triangular Slaney-normalised filters, [N_MELS][BINS], as transformers' `mel_filter_bank`. */
function melFilters(): Float64Array[] {
  const low = hzToMel(0);
  const high = hzToMel(SAMPLE_RATE / 2);
  const edges = Array.from({ length: N_MELS + 2 }, (_, i) =>
    melToHz(low + ((high - low) * i) / (N_MELS + 1)),
  );
  const fftHz = Array.from({ length: BINS }, (_, i) => ((SAMPLE_RATE / 2) * i) / (BINS - 1));
  return Array.from({ length: N_MELS }, (_, m) => {
    const row = new Float64Array(BINS);
    const norm = 2 / (edges[m + 2]! - edges[m]!);
    for (let b = 0; b < BINS; b++) {
      const down = (fftHz[b]! - edges[m]!) / (edges[m + 1]! - edges[m]!);
      const up = (edges[m + 2]! - fftHz[b]!) / (edges[m + 2]! - edges[m + 1]!);
      row[b] = Math.max(0, Math.min(down, up)) * norm;
    }
    return row;
  });
}

/**
 * The real DFT of one 400-sample frame, bins 0..200, as a mixed-radix (2 x 2 x 2 x 2 x 5 x 5)
 * Cooley-Tukey FFT over precomputed twiddles.
 */
class Fft400 {
  private readonly cos = new Float64Array(N_FFT);
  private readonly sin = new Float64Array(N_FFT);
  private readonly re = new Float64Array(N_FFT);
  private readonly im = new Float64Array(N_FFT);
  private readonly scratchRe = new Float64Array(N_FFT);
  private readonly scratchIm = new Float64Array(N_FFT);

  constructor() {
    for (let k = 0; k < N_FFT; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / N_FFT);
      this.sin[k] = -Math.sin((2 * Math.PI * k) / N_FFT);
    }
  }

  /** |X[k]|^2 for k = 0..200 into `power`. */
  power(frame: Float64Array, power: Float64Array): void {
    this.re.set(frame);
    this.im.fill(0);
    this.transform(0, N_FFT);
    for (let k = 0; k < BINS; k++) power[k] = this.re[k]! ** 2 + this.im[k]! ** 2;
  }

  /** In-place decimation-in-time FFT of the `n` contiguous points at `offset`. */
  private transform(offset: number, n: number): void {
    if (n === 1) return;
    const radix = n % 2 === 0 ? 2 : 5;
    const m = n / radix;
    // Split into `radix` interleaved subsequences, each transformed in place.
    const { scratchRe, scratchIm, re, im } = this;
    for (let r = 0; r < radix; r++)
      for (let j = 0; j < m; j++) {
        scratchRe[offset + r * m + j] = re[offset + (j * radix + r)]!;
        scratchIm[offset + r * m + j] = im[offset + (j * radix + r)]!;
      }
    for (let i = 0; i < n; i++) {
      re[offset + i] = scratchRe[offset + i]!;
      im[offset + i] = scratchIm[offset + i]!;
    }
    for (let r = 0; r < radix; r++) this.transform(offset + r * m, m);
    // Combine: X[k + q m] = sum_r W_n^{r (k + q m)} Y_r[k].
    const step = N_FFT / n;
    for (let k = 0; k < m; k++)
      for (let q = 0; q < radix; q++) {
        const out = k + q * m;
        let sumRe = 0;
        let sumIm = 0;
        for (let r = 0; r < radix; r++) {
          const w = ((r * out) % n) * step;
          const yRe = re[offset + r * m + k]!;
          const yIm = im[offset + r * m + k]!;
          sumRe += yRe * this.cos[w]! - yIm * this.sin[w]!;
          sumIm += yRe * this.sin[w]! + yIm * this.cos[w]!;
        }
        scratchRe[offset + out] = sumRe;
        scratchIm[offset + out] = sumIm;
      }
    for (let i = 0; i < n; i++) {
      re[offset + i] = scratchRe[offset + i]!;
      im[offset + i] = scratchIm[offset + i]!;
    }
  }
}

/** Each filter's non-zero span (a few bins to a few dozen): the rest contribute nothing. */
const FILTERS = melFilters().map((row) => {
  const first = row.findIndex((w) => w > 0);
  const last = row.findLastIndex((w) => w > 0);
  return first < 0
    ? { first: 0, weights: new Float64Array(0) }
    : { first, weights: row.slice(first, last + 1) };
});
/** transformers' `window_function(400, "hann")`: periodic. */
const HANN = Float64Array.from(
  { length: N_FFT },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT),
);
const fft = new Fft400();

/**
 * The last 8 s of `pcm` (16 kHz), left-padded with silence when shorter, as Smart Turn's
 * `truncate_audio_to_last_n_seconds`, scaled to [-1, 1).
 */
export function lastWindow(pcm: Int16Array): Float32Array {
  const out = new Float32Array(WINDOW_SAMPLES);
  const take = Math.min(pcm.length, WINDOW_SAMPLES);
  const from = pcm.length - take;
  for (let i = 0; i < take; i++) out[WINDOW_SAMPLES - take + i] = pcm[from + i]! / 32768;
  return out;
}

export function logMel(window: Float32Array): Float32Array {
  if (window.length !== WINDOW_SAMPLES) throw new Error(`expected ${WINDOW_SAMPLES} samples`);
  let mean = 0;
  for (const x of window) mean += x;
  mean /= window.length;
  let variance = 0;
  for (const x of window) variance += (x - mean) ** 2;
  variance /= window.length;
  const scale = 1 / Math.sqrt(variance + 1e-7);
  // Centred frames: reflect-pad n_fft / 2 on both sides.
  const pad = N_FFT / 2;
  const padded = new Float64Array(WINDOW_SAMPLES + N_FFT);
  for (let i = 0; i < padded.length; i++) {
    let j = i - pad;
    if (j < 0) j = -j;
    else if (j >= WINDOW_SAMPLES) j = 2 * (WINDOW_SAMPLES - 1) - j;
    padded[i] = (window[j]! - mean) * scale;
  }
  const out = new Float32Array(N_MELS * N_FRAMES);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(BINS);
  let max = -Infinity;
  // 801 frames; the last is dropped.
  for (let t = 0; t < N_FRAMES; t++) {
    const start = t * HOP;
    for (let i = 0; i < N_FFT; i++) frame[i] = padded[start + i]! * HANN[i]!;
    fft.power(frame, power);
    for (let m = 0; m < N_MELS; m++) {
      const { first, weights } = FILTERS[m]!;
      let energy = 0;
      for (let b = 0; b < weights.length; b++) energy += weights[b]! * power[first + b]!;
      const value = Math.log10(Math.max(energy, 1e-10));
      out[m * N_FRAMES + t] = value;
      if (value > max) max = value;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i]!, max - 8) + 4) / 4;
  return out;
}
