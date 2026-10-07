import type { AudioFilter } from '@winsendotai/ovo-contracts';
import { Biquad } from './biquad.ts';
import type { AudioFilterConfig } from './config.ts';
import { NoiseGate } from './noise-gate.ts';

/** Pole Qs of a 4th-order Butterworth high-pass, one per section. */
const BUTTERWORTH_Q = [0.5412, 1.3066] as const;

/**
 * The caller-audio clean-up (`ovo.audio-filter`): high-pass, mains-hum notches and an optional
 * noise gate, in that order. Causal IIR sections with no look-ahead, so it adds no buffering
 * latency; group delay above 300 Hz is under 1 ms. About 35 multiply-adds per sample with every
 * stage on: ~6,000 for a 20 ms frame at 8 kHz.
 */
export class TelephonyAudioFilter implements AudioFilter {
  private sections: Biquad[] = [];
  private gate?: NoiseGate;
  private buffer = new Float64Array(0);

  constructor(private readonly config: AudioFilterConfig) {}

  start(rate: number): void {
    const { highPassHz, hum, gate } = this.config;
    this.sections = [
      ...(highPassHz > 0 ? BUTTERWORTH_Q.map((q) => Biquad.highPass(rate, highPassHz, q)) : []),
      ...(hum
        ? Array.from({ length: hum.harmonics }, (_, i) => (i + 1) * hum.mainsHz)
            .filter((hz) => hz < rate / 2)
            .map((hz) => Biquad.notch(rate, hz, hum.q))
        : []),
    ];
    this.gate = gate ? new NoiseGate(rate, gate) : undefined;
  }

  /** Returns a filtered copy; frames may be any length and state carries across them. */
  filter(pcm: Int16Array): Int16Array {
    if (this.buffer.length < pcm.length) this.buffer = new Float64Array(pcm.length);
    const samples = this.buffer.subarray(0, pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]!;
    for (const section of this.sections) section.run(samples);
    this.gate?.run(samples);
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]!)));
    return out;
  }

  stop(): void {
    for (const section of this.sections) section.reset();
    this.gate?.reset();
  }
}
