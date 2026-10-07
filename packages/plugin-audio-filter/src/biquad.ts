/**
 * One second-order IIR section (RBJ Audio EQ Cookbook forms), transposed direct form II, its state
 * carried across calls so frame edges add no clicks. Five multiply-adds per sample.
 * Source: https://www.w3.org/TR/audio-eq-cookbook/ (retrieved 2026-10-07).
 */
export class Biquad {
  private z1 = 0;
  private z2 = 0;

  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  /** A high-pass at `hz` with quality `q` (0.7071 is a 2nd-order Butterworth). */
  static highPass(rate: number, hz: number, q: number): Biquad {
    const { cos, alpha } = Biquad.prewarp(rate, hz, q);
    const a0 = 1 + alpha;
    return new Biquad(
      (1 + cos) / 2 / a0,
      -(1 + cos) / a0,
      (1 + cos) / 2 / a0,
      (-2 * cos) / a0,
      (1 - alpha) / a0,
    );
  }

  /** A notch at `hz`, `hz / q` wide: removes one mains-hum harmonic and nothing around it. */
  static notch(rate: number, hz: number, q: number): Biquad {
    const { cos, alpha } = Biquad.prewarp(rate, hz, q);
    const a0 = 1 + alpha;
    return new Biquad(1 / a0, (-2 * cos) / a0, 1 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  private static prewarp(rate: number, hz: number, q: number) {
    const w0 = (2 * Math.PI * Math.min(hz, rate * 0.49)) / rate;
    return { cos: Math.cos(w0), alpha: Math.sin(w0) / (2 * q) };
  }

  /** Filters `samples` in place. */
  run(samples: Float64Array): void {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      samples[i] = y;
    }
  }

  reset(): void {
    this.z1 = this.z2 = 0;
  }
}
