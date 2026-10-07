import type { VadAnalyzer } from '@winsendotai/ovo-contracts';
import { CallerLevel } from './caller-level.ts';
import type { EnergyVadConfig } from './config.ts';
import { HighPass } from './prefilter.ts';
import { ToneDetector } from './tonality.ts';

const FRAME_MS = 20;
const FLOOR_START_DB = -65;
const SILENT_DB = -110;
/** The logistic is centred this far above the noise floor. */
const MARGIN_DB = 9;
/** The floor falls quickly, and rises in 2 s through anything that is not modulated speech. */
const FLOOR_FALL_MS = 100;
const FLOOR_RISE_MS = 2000;
/**
 * Mean frame-to-frame level change (dB, averaged over ~300 ms) that marks modulated, speech-like
 * sound. 99% of speech frames measure above 1.76 dB; a fan, a hum or a steady buzz stays near 0.
 */
const MODULATED_DB = 1;
const MODULATION_ALPHA = 1 - Math.exp(-FRAME_MS / 300);
/**
 * One talker pauses: within a few seconds some frame falls back within 6 dB of the floor. Until a
 * frame has shown where the floor is, and once a sound stays above it for 4 s (a TV, a crowd from
 * the moment the call connects), the floor rises at its normal pace, whatever the sound's rhythm.
 */
const NEAR_FLOOR_DB = 6;
const MAX_FROZEN_MS = 4000;
/** A frame changing by more than this (an onset) counts only this much towards modulation. */
const MAX_DELTA_DB = 20;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function level(samples: ArrayLike<number>): { db: number; crossings: number } {
  let power = 0;
  let crossings = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    power += sample * sample;
    if (i && sample >= 0 !== samples[i - 1]! >= 0) crossings++;
  }
  const rms = samples.length ? Math.sqrt(power / samples.length) / 32768 : 0;
  return { db: rms ? 20 * Math.log10(rms) : SILENT_DB, crossings };
}

/** The host's start/stop counting (IngressVad), mirrored so the analyzer knows a run is open. */
class SpeechRun {
  active = false;
  private consecutive = 0;

  constructor(
    private readonly startFrames: number,
    private readonly stopFrames: number,
  ) {}

  observe(speech: boolean): void {
    if (speech === this.active) {
      this.consecutive = 0;
      return;
    }
    if (++this.consecutive < (speech ? this.startFrames : this.stopFrames)) return;
    this.active = speech;
    this.consecutive = 0;
  }

  reset(): void {
    this.active = false;
    this.consecutive = 0;
  }
}

/**
 * Deterministic 20 ms RMS/ZCR analyzer for phone audio. Its noise floor falls quickly, rises
 * slowly, and nearly stops rising while modulated speech is present, so a long utterance cannot
 * raise the floor into its own level. Rumble below `highPassHz`, steady tones and, once the
 * caller's level is learned, far-field talkers never start speech. Per frame: a 10-multiply-add
 * high-pass per sample, and an order-8 predictor (~7,000 multiply-adds) only for frames above the
 * floor's margin.
 */
export class EnergyVad implements VadAnalyzer {
  readonly frameSamples: number;
  private floor = FLOOR_START_DB;
  private aboveFloorMs = Infinity;
  private confidenceState = 0;
  private volumeState = 0;
  private lastDb = SILENT_DB;
  private modulation = 0;
  private readonly highPass?: HighPass;
  private readonly tones = new ToneDetector();
  private readonly caller: CallerLevel;
  private readonly run: SpeechRun;
  /** The frame the last confidence() call analysed, and whether its volume is held up. */
  private analysed?: Int16Array;
  private holdVolume = false;

  constructor(
    readonly sampleRate: 8000 | 16000,
    private readonly config: EnergyVadConfig,
  ) {
    this.frameSamples = sampleRate / 50;
    if (config.highPassHz > 0)
      this.highPass = new HighPass(sampleRate, config.highPassHz, this.frameSamples);
    this.caller = new CallerLevel(config.callerGateDb);
    this.run = new SpeechRun(
      Math.max(1, Math.round(config.startMs / FRAME_MS)),
      Math.max(1, Math.round(config.stopMs / FRAME_MS)),
    );
  }

  confidence(pcm: Int16Array): number {
    this.checkFrame(pcm);
    const samples = this.highPass ? this.highPass.apply(pcm) : pcm;
    const { db, crossings } = level(samples);
    const delta = Math.min(MAX_DELTA_DB, Math.abs(db - this.lastDb));
    this.lastDb = db;
    this.modulation += MODULATION_ALPHA * (delta - this.modulation);
    const floor = this.floor;
    this.aboveFloorMs = db < floor + NEAR_FLOOR_DB ? 0 : this.aboveFloorMs + FRAME_MS;
    const loud = db > floor + MARGIN_DB;
    const tonal = this.tones.observe(samples, delta, loud && this.config.rejectTones);
    let raw = crossings >= 3 && !tonal ? sigmoid((db - floor - MARGIN_DB) / 3) : 0;
    // The gate only keeps far-field talk from starting speech; it never cuts the caller off.
    if (!this.run.active && this.caller.farField(db)) raw = 0;
    this.confidenceState =
      this.config.smoothing * this.confidenceState + (1 - this.config.smoothing) * raw;
    const confidence = Math.max(0, Math.min(1, this.confidenceState));

    this.volumeState = 0.1 * this.volumeState + 0.9 * this.normalizedVolume(level(pcm).db);
    const confident = confidence >= this.config.confidence;
    this.run.observe(confident && (this.run.active || this.volumeState >= this.config.minVolume));
    this.caller.observe(db, this.run.active && raw >= 0.5, floor);
    this.analysed = pcm;
    this.holdVolume = this.run.active && confident;

    const speech =
      loud && !tonal && this.modulation >= MODULATED_DB && this.aboveFloorMs <= MAX_FROZEN_MS;
    const tauMs =
      db <= floor ? FLOOR_FALL_MS : speech ? this.config.speechFloorTauMs : FLOOR_RISE_MS;
    this.floor = floor + (1 - Math.exp(-FRAME_MS / tauMs)) * (db - floor);
    return confidence;
  }

  /**
   * The frame's level. Inside an utterance a confident frame reports at least minVolume: a soft
   * syllable 20 dB above the noise floor is still speech, so absolute level alone cannot end it.
   */
  volume(pcm: Int16Array): number {
    this.checkFrame(pcm);
    const raw = this.normalizedVolume(level(pcm).db);
    this.volumeState = 0.1 * this.volumeState + 0.9 * raw;
    if (pcm === this.analysed && this.holdVolume)
      return Math.max(this.volumeState, this.config.minVolume);
    return this.volumeState;
  }

  reset(): void {
    this.floor = FLOOR_START_DB;
    this.aboveFloorMs = Infinity;
    this.confidenceState = 0;
    this.volumeState = 0;
    this.lastDb = SILENT_DB;
    this.modulation = 0;
    this.highPass?.reset();
    this.tones.reset();
    this.caller.reset();
    this.run.reset();
    this.analysed = undefined;
    this.holdVolume = false;
  }

  private normalizedVolume(db: number): number {
    const linear = Math.max(0, Math.min(1, (db + 110) / 100));
    return linear * linear;
  }

  private checkFrame(pcm: Int16Array): void {
    if (pcm.length !== this.frameSamples)
      throw new RangeError(`expected ${this.frameSamples} PCM samples per 20 ms frame`);
  }
}
