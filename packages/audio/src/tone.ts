/**
 * Goertzel's algorithm: the squared magnitude of the DFT at `freq` (a sine of amplitude A, N
 * samples, reads (A·N/2)²). O(N), no FFT; compare it through `toneShare` rather than directly.
 */
export function goertzelPower(
  samples: ArrayLike<number>,
  sampleRate: number,
  freq: number,
): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let previous = 0;
  let before = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const current = samples[i]! + coefficient * previous - before;
    before = previous;
    previous = current;
  }
  return previous * previous + before * before - coefficient * previous * before;
}

/**
 * The share of the signal's energy that sits at `freq` (0 for silence, about 1 for a clean sine at
 * that frequency, near 0 for a sine elsewhere). A tone detector for end-to-end audio checks: two
 * different tones can be told apart after a codec chain with no phase or alignment bookkeeping.
 */
export function toneShare(samples: ArrayLike<number>, sampleRate: number, freq: number): number {
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) energy += samples[i]! * samples[i]!;
  if (energy === 0) return 0;
  // A sine of amplitude A has Goertzel power (A·N/2)² and energy A²·N/2, so the ratio below is 1.
  return goertzelPower(samples, sampleRate, freq) / ((samples.length * energy) / 2);
}
