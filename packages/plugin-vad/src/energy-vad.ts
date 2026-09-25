import type { VadAnalyzer, VadParams } from '@winsendotai/ovo-contracts';

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function level(pcm: Int16Array): { db: number; crossings: number } {
  let power = 0;
  let crossings = 0;
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i]!;
    power += sample * sample;
    if (i && (sample >= 0) !== (pcm[i - 1]! >= 0)) crossings++;
  }
  const rms = pcm.length ? Math.sqrt(power / pcm.length) / 32768 : 0;
  return { db: rms ? 20 * Math.log10(rms) : -110, crossings };
}

/** Deterministic 20 ms RMS/ZCR analyzer with a slowly rising, quickly falling noise floor. */
export class EnergyVad implements VadAnalyzer {
  readonly frameSamples: number;
  private floor = -65;
  private confidenceState = 0;
  private volumeState = 0;

  constructor(readonly sampleRate: 8000 | 16000, private readonly params: VadParams) {
    this.frameSamples = sampleRate / 50;
  }

  confidence(pcm: Int16Array): number {
    this.checkFrame(pcm);
    const { db, crossings } = level(pcm);
    const rawVolume = this.normalizedVolume(db);
    this.volumeState = 0.1 * this.volumeState + 0.9 * rawVolume;
    const enoughCrossings = crossings >= 3;
    const raw = enoughCrossings
      ? sigmoid((db - this.floor - 9) / 3) : 0;
    this.confidenceState = this.params.smoothing * this.confidenceState +
      (1 - this.params.smoothing) * raw;
    const tauMs = db > this.floor ? 2000 : 100;
    this.floor += (1 - Math.exp(-20 / tauMs)) * (db - this.floor);
    return Math.max(0, Math.min(1, this.confidenceState));
  }

  volume(pcm: Int16Array): number {
    this.checkFrame(pcm);
    const raw = this.normalizedVolume(level(pcm).db);
    this.volumeState = 0.1 * this.volumeState + 0.9 * raw;
    return this.volumeState;
  }

  reset(): void { this.floor = -65; this.confidenceState = 0; this.volumeState = 0; }

  private normalizedVolume(db: number): number {
    const linear = Math.max(0, Math.min(1, (db + 110) / 100));
    return linear * linear;
  }

  private checkFrame(pcm: Int16Array): void {
    if (pcm.length !== this.frameSamples) throw new RangeError(`expected ${this.frameSamples} PCM samples per 20 ms frame`);
  }
}
