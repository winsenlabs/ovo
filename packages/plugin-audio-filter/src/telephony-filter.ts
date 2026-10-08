import type { AudioFilter } from '@winsendotai/ovo-contracts';
import { Biquad } from './biquad.ts';
import type { AudioFilterConfig } from './config.ts';
import { LineFaults } from './line-faults.ts';
import { NoiseGate } from './noise-gate.ts';

/** Pole Qs of a 4th-order Butterworth high-pass, one per section. */
const BUTTERWORTH_Q = [0.5412, 1.3066] as const;
/** A stage that engages mid-call fades in over this long, so the switch makes no click. */
const FADE_MS = 20;

/**
 * How far each stage is mixed in: 0 passes the audio through untouched, 1 is fully in. A stage
 * that engages mid-call glides from one to the other over `FADE_MS`.
 */
class Fade {
  private readonly step: number;

  constructor(
    rate: number,
    public mix: number,
  ) {
    this.step = 1000 / (FADE_MS * rate);
  }

  /** Called once per sample while the stage is engaged. */
  advance(): void {
    if (this.mix < 1) this.mix = Math.min(1, this.mix + this.step);
  }
}

/**
 * The caller-audio clean-up (`ovo.audio-filter`): high-pass, mains-hum notches and an optional
 * noise gate, in that order. Causal IIR sections with no look-ahead, so it adds no buffering
 * latency; group delay above 300 Hz is under 1 ms. About 35 multiply-adds per sample with every
 * stage on: ~6,000 for a 20 ms frame at 8 kHz, plus ~20 per sample while `engage: 'detect'` is
 * still listening for a fault.
 */
export class TelephonyAudioFilter implements AudioFilter {
  private highPass: Biquad[] = [];
  private notches: Biquad[] = [];
  private highPassFade?: Fade;
  private notchFade?: Fade;
  private faults?: LineFaults;
  private gate?: NoiseGate;
  private buffer = new Float64Array(0);

  constructor(private readonly config: AudioFilterConfig) {}

  start(rate: number): void {
    const { highPassHz, hum, gate, engage } = this.config;
    const always = engage === 'always';
    this.highPass =
      highPassHz > 0 ? BUTTERWORTH_Q.map((q) => Biquad.highPass(rate, highPassHz, q)) : [];
    this.notches = hum
      ? Array.from({ length: hum.harmonics }, (_, i) => (i + 1) * hum.mainsHz)
          .filter((hz) => hz < rate / 2)
          .map((hz) => Biquad.notch(rate, hz, hum.q))
      : [];
    this.highPassFade = new Fade(rate, always ? 1 : 0);
    this.notchFade = new Fade(rate, always ? 1 : 0);
    this.faults = always
      ? undefined
      : new LineFaults(rate, this.notches.length ? hum : null, this.highPass.length > 0);
    this.gate = gate ? new NoiseGate(rate, gate) : undefined;
  }

  /** Returns a filtered copy; frames may be any length and state carries across them. */
  filter(pcm: Int16Array): Int16Array {
    if (this.buffer.length < pcm.length) this.buffer = new Float64Array(pcm.length);
    const samples = this.buffer.subarray(0, pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]!;
    const faults = this.faults;
    if (faults && !faults.settled) faults.observe(samples);
    this.clean(samples, !faults || faults.rumble || faults.hum, !faults || faults.hum);
    this.gate?.run(samples);
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]!)));
    return out;
  }

  /**
   * The high-pass, then the notches, in place. Every section runs on every sample, so a stage
   * that engages mid-call starts from settled state; until then its output is mixed out. The
   * high-pass also takes the hum's fundamental, so hum engages it too.
   */
  private clean(samples: Float64Array, highPass: boolean, notches: boolean): void {
    const hp = this.highPassFade!;
    const notch = this.notchFade!;
    if (hp.mix >= 1 && notch.mix >= 1) {
      for (const section of this.highPass) section.run(samples);
      for (const section of this.notches) section.run(samples);
      return;
    }
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      let a = x;
      for (const section of this.highPass) a = section.step(a);
      let b = a;
      for (const section of this.notches) b = section.step(b);
      if (highPass) hp.advance();
      if (notches) notch.advance();
      // Exactly the input while neither is engaged, so an untouched line stays sample-identical.
      samples[i] = hp.mix || notch.mix ? x + (a - x) * hp.mix + (b - a) * notch.mix : x;
    }
  }

  stop(): void {
    for (const section of [...this.highPass, ...this.notches]) section.reset();
    this.gate?.reset();
  }
}
