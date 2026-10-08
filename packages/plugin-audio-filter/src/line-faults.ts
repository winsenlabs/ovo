import { Biquad } from './biquad.ts';

/** Each verdict reads a quarter second: 4 Hz bins, fine enough to split hum from the voice. */
const BLOCK_SECONDS = 0.25;
/** Hum must hold for a second: a voice never sits on one mains harmonic that long. */
const HUM_BLOCKS = 4;
/** Mains harmonics this many times stronger than the bins between them are hum (10 dB). */
const HUM_RATIO = 10;
/** Rumble: a quarter of a block's power below 80 Hz, where telephone speech has almost none. */
const RUMBLE_SHARE = 0.25;
const RUMBLE_HZ = 80;
/** Blocks quieter than this (-50 dBFS) are line silence and decide nothing. */
const QUIET_POWER = (32768 * 10 ** (-50 / 20)) ** 2;

/** Power at `hz` over one block (Goertzel), updated sample by sample. */
class Tone {
  private s1 = 0;
  private s2 = 0;
  private readonly coefficient: number;

  constructor(rate: number, hz: number) {
    this.coefficient = 2 * Math.cos((2 * Math.PI * hz) / rate);
  }

  push(x: number): void {
    const s = x + this.coefficient * this.s1 - this.s2;
    this.s2 = this.s1;
    this.s1 = s;
  }

  take(): number {
    const power = this.s1 * this.s1 + this.s2 * this.s2 - this.coefficient * this.s1 * this.s2;
    this.s1 = this.s2 = 0;
    return power;
  }
}

/**
 * Wave 8: which line faults this call has. The high-pass and the hum notches help only a line
 * that has the fault they fix; on a clean line or in a cafe's babble they cost words (the
 * transcript-quality regression), so each engages once its fault is heard and stays on for the
 * call. Hum: the mains harmonics stand 10 dB over the bins between them for a whole second.
 * Rumble: a quarter of a block's power is below 80 Hz.
 */
export class LineFaults {
  hum = false;
  rumble = false;
  private readonly block: number;
  private readonly harmonics: Tone[];
  private readonly between: Tone[];
  private readonly low: Biquad;
  private at = 0;
  private power = 0;
  private lowPower = 0;
  private humBlocks = 0;

  constructor(
    rate: number,
    hum: { mainsHz: number; harmonics: number } | null,
    private readonly watchRumble: boolean,
  ) {
    this.block = Math.round(rate * BLOCK_SECONDS);
    const below = (hz: number) => hz < rate / 2;
    const multiples = hum
      ? Array.from({ length: hum.harmonics }, (_, i) => (i + 1) * hum.mainsHz).filter(below)
      : [];
    this.harmonics = multiples.map((hz) => new Tone(rate, hz));
    this.between = hum ? multiples.map((hz) => new Tone(rate, hz + hum.mainsHz / 2)) : [];
    this.low = Biquad.lowPass(rate, RUMBLE_HZ, Math.SQRT1_2);
  }

  /** True once every fault being watched for has been heard: nothing is left to listen for. */
  get settled(): boolean {
    return (this.hum || !this.harmonics.length) && (this.rumble || !this.watchRumble);
  }

  /** Listens to `samples` (raw, before any filter). */
  observe(samples: Float64Array): void {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      this.power += x * x;
      if (!this.hum) {
        for (const tone of this.harmonics) tone.push(x);
        for (const tone of this.between) tone.push(x);
      }
      if (this.watchRumble && !this.rumble) {
        const low = this.low.step(x);
        this.lowPower += low * low;
      }
      if (++this.at === this.block) this.decide();
    }
  }

  private decide(): void {
    const loud = this.power / this.block >= QUIET_POWER;
    const harmonics = this.harmonics.reduce((sum, tone) => sum + tone.take(), 0);
    const between = this.between.reduce((sum, tone) => sum + tone.take(), 0);
    if (!this.hum && this.harmonics.length) {
      this.humBlocks = loud && harmonics > HUM_RATIO * between ? this.humBlocks + 1 : 0;
      if (this.humBlocks >= HUM_BLOCKS) this.hum = true;
    }
    if (this.watchRumble && loud && this.lowPower >= RUMBLE_SHARE * this.power) this.rumble = true;
    this.at = 0;
    this.power = this.lowPower = 0;
  }
}
