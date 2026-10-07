/** Pole Qs of a 4th-order Butterworth response, one per second-order section. */
const BUTTERWORTH_Q = [0.5412, 1.3066] as const;

/**
 * A 4th-order Butterworth high-pass (24 dB/octave) over the VAD's copy of the audio. At a 200 Hz
 * corner, handling rumble at 100 Hz loses 24 dB and 50 Hz hum 48 dB, while telephone speech
 * (300 Hz and up) loses under 0.2 dB. State carries across frames, so frame edges add no clicks.
 */
export class HighPass {
  /** Per section: b0 (b1 = -2·b0, b2 = b0), a1, a2, then the two delay-line states. */
  private readonly sections: Float64Array[];
  private readonly out: Float64Array;

  constructor(rate: number, cornerHz: number, frameSamples: number) {
    const k = Math.tan((Math.PI * Math.min(cornerHz, rate * 0.45)) / rate);
    this.sections = BUTTERWORTH_Q.map((q) => {
      const norm = 1 / (1 + k / q + k * k);
      return Float64Array.of(norm, 2 * (k * k - 1) * norm, (1 - k / q + k * k) * norm, 0, 0);
    });
    this.out = new Float64Array(frameSamples);
  }

  /** Filters one frame into a reused buffer: ten multiply-adds per sample. */
  apply(pcm: Int16Array): Float64Array {
    for (let i = 0; i < pcm.length; i++) {
      let x = pcm[i]!;
      for (const s of this.sections) {
        // Transposed direct form II.
        const y = s[0]! * x + s[3]!;
        s[3] = -2 * s[0]! * x - s[1]! * y + s[4]!;
        s[4] = s[0]! * x - s[2]! * y;
        x = y;
      }
      this.out[i] = x;
    }
    return this.out;
  }

  reset(): void {
    for (const s of this.sections) s[3] = s[4] = 0;
  }
}
