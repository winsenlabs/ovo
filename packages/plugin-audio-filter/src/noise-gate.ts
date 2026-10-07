import type { AudioFilterConfig } from './config.ts';

/** The gate decides every 2 ms, on the block it is about to scale, so it adds no latency. */
const BLOCK_MS = 2;
/** Gain glides up in ~1 ms (an onset is never clipped) and down over `releaseMs`. */
const ATTACK_MS = 1;
/** The floor falls in 100 ms, rises in 1 s while the gate is shut and in 10 s while it is open. */
const FLOOR_FALL_MS = 100;
const FLOOR_RISE_SHUT_MS = 1000;
const FLOOR_RISE_OPEN_MS = 10000;
/** A call that opens on noise starts its floor there, but never above this. */
const FLOOR_CEILING_DB = -50;

const coefficient = (ms: number, perSecond: number) => 1 - Math.exp(-1000 / (ms * perSecond));

/**
 * A downward expander: between the caller's words, sound within `thresholdDb` of the tracked
 * noise floor is turned down by `rangeDb`; anything louder passes untouched. It never removes
 * sound, so an STT still hears a soft word under it, only quieter.
 */
export class NoiseGate {
  private readonly block: number;
  private readonly holdSamples: number;
  private readonly range: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly fall: number;
  private readonly riseShut: number;
  private readonly riseOpen: number;
  private floor?: number;
  private holdLeft = 0;
  private gain = 1;

  constructor(
    rate: number,
    private readonly config: NonNullable<AudioFilterConfig['gate']>,
  ) {
    this.block = Math.max(1, Math.round((rate * BLOCK_MS) / 1000));
    this.holdSamples = Math.round((rate * config.holdMs) / 1000);
    this.range = 10 ** (-config.rangeDb / 20);
    this.attack = coefficient(ATTACK_MS, rate);
    this.release = coefficient(config.releaseMs, rate);
    const blocksPerSecond = 1000 / BLOCK_MS;
    this.fall = coefficient(FLOOR_FALL_MS, blocksPerSecond);
    this.riseShut = coefficient(FLOOR_RISE_SHUT_MS, blocksPerSecond);
    this.riseOpen = coefficient(FLOOR_RISE_OPEN_MS, blocksPerSecond);
  }

  /** Scales `samples` in place. */
  run(samples: Float64Array): void {
    for (let start = 0; start < samples.length; start += this.block) {
      const end = Math.min(samples.length, start + this.block);
      let power = 0;
      for (let i = start; i < end; i++) power += samples[i]! * samples[i]!;
      const rms = Math.sqrt(power / (end - start)) / 32768;
      const db = rms > 0 ? 20 * Math.log10(rms) : -120;
      const floor = (this.floor ??= Math.min(db, FLOOR_CEILING_DB));
      if (db > floor + this.config.thresholdDb) this.holdLeft = this.holdSamples;
      const open = this.holdLeft > 0;
      this.holdLeft = Math.max(0, this.holdLeft - (end - start));
      const rise = open ? this.riseOpen : this.riseShut;
      this.floor = floor + (db < floor ? this.fall : rise) * (db - floor);
      const target = open ? 1 : this.range;
      const glide = target > this.gain ? this.attack : this.release;
      for (let i = start; i < end; i++) {
        this.gain += glide * (target - this.gain);
        samples[i] = samples[i]! * this.gain;
      }
    }
  }

  reset(): void {
    this.floor = undefined;
    this.holdLeft = 0;
    this.gain = 1;
  }
}
