/** Linear-prediction order: two tones (DTMF, ring-back) need four, μ-law noise needs the rest. */
const ORDER = 8;
/**
 * A frame predictable to this many dB is a tone. Calibrated on 11,560 frames of 8 kHz μ-law Indian
 * English and Hindi speech (max 30.0 dB) against μ-law beeps (≥ 33.6), DTMF (≥ 31.7 for a -38 dBFS
 * pair) and ring-back (30.6, caught by the steady rule).
 */
const TONE_GAIN_DB = 32;
/** A steadier, still well-predicted sound: speech frames reach this, but not at a steady level. */
const STEADY_GAIN_DB = 20;
/** Frame-to-frame level change below which a frame is steady, and how many make a tone. */
const STEADY_DB = 0.75;
const STEADY_FRAMES = 4;
/**
 * However unpredictable its waveform (a square-wave buzz predicts to 5 dB), a sound this steady for
 * this long is a machine. Real speech held its level that steadily for at most 7 frames, 3 times.
 */
const MACHINE_FRAMES = 7;

/**
 * Prediction gain of an order-8 covariance-method linear predictor, in dB: how much of the frame's
 * energy the previous eight samples explain. Speech averages 11 dB; a pure tone is only limited by
 * μ-law quantisation. About 7,000 multiply-adds for a 20 ms frame at 8 kHz.
 */
export function predictionGainDb(x: ArrayLike<number>): number {
  const n = x.length;
  // phi[i][j] = Σ x[t-i]·x[t-j] over t in [ORDER, n), so no zero padding biases the fit.
  const phi: number[][] = [];
  for (let i = 0; i <= ORDER; i++) phi.push(new Array<number>(ORDER + 1).fill(0));
  for (let i = 0; i <= ORDER; i++)
    for (let j = i; j <= ORDER; j++) {
      let sum = 0;
      for (let t = ORDER; t < n; t++) sum += x[t - i]! * x[t - j]!;
      phi[i]![j] = phi[j]![i] = sum;
    }
  const energy = phi[0]![0]!;
  if (!(energy > 0)) return 0;
  // Cholesky of phi[1..][1..], lightly regularised so a perfect tone stays solvable.
  const l: number[][] = [];
  for (let i = 0; i < ORDER; i++) {
    l.push(new Array<number>(ORDER).fill(0));
    for (let j = 0; j <= i; j++) {
      let sum = phi[i + 1]![j + 1]! + (i === j ? energy * 1e-9 : 0);
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (!(sum > 0)) return 0;
        l[i]![i] = Math.sqrt(sum);
      } else l[i]![j] = sum / l[j]![j]!;
    }
  }
  // Solve L·y = phi[1..][0]; the residual energy is energy − |y|².
  let explained = 0;
  const y: number[] = [];
  for (let i = 0; i < ORDER; i++) {
    let sum = phi[i + 1]![0]!;
    for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!;
    y.push(sum / l[i]![i]!);
    explained += y[i]! * y[i]!;
  }
  const residual = energy - explained;
  return residual > 0 ? 10 * Math.log10(energy / residual) : 99;
}

/** Beeps, DTMF, ring-back and a vibrating phone's buzz: highly predictable, or perfectly steady. */
export class ToneDetector {
  private steady = 0;

  /** `delta` is the frame's level change in dB; the predictor runs only for `loud` frames. */
  observe(frame: ArrayLike<number>, delta: number, loud: boolean): boolean {
    this.steady = delta < STEADY_DB ? this.steady + 1 : 0;
    if (!loud) return false;
    if (this.steady >= MACHINE_FRAMES) return true;
    const gain = predictionGainDb(frame);
    return gain >= TONE_GAIN_DB || (gain >= STEADY_GAIN_DB && this.steady >= STEADY_FRAMES);
  }

  reset(): void {
    this.steady = 0;
  }
}
