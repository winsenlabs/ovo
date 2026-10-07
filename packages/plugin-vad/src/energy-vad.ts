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
/**
 * Inside an utterance a tone ends it only once it has lasted this long: a held vowel or a "mmm"
 * can predict like a tone for the best part of a second, and a stop there ends the turn early.
 */
const RUN_TONE_FRAMES = 1500 / FRAME_MS;
/**
 * Until the caller's level is learned, at most this much of an utterance's audio under minVolume
 * is held up, so sound below the caller's level cannot hold the utterance open for long.
 */
const MAX_HELD_FRAMES = 300 / FRAME_MS;
/** The frame power averaged over ~100 ms, compared with the caller's level as well as the frame. */
const SHORT_ALPHA = 1 - Math.exp(-FRAME_MS / 100);

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
 * caller's level is learned, far-field talkers never start speech, and sound that far below the
 * caller neither freezes the floor nor holds an utterance open. Per frame: a 10-multiply-add
 * high-pass per sample, an order-8 predictor (~7,000 multiply-adds) only for frames above the
 * floor's margin, and a handful of scalar operations for the caller gate.
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
  /** Consecutive tonal frames, and this utterance's frames held up to minVolume. */
  private tonalFrames = 0;
  private heldFrames = 0;
  private shortPower = 0;
  /** The sound is more than the gate below the caller's learned level: the room, not the caller. */
  private distant = false;

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
    this.shortPower += SHORT_ALPHA * (10 ** (db / 10) - this.shortPower);
    // The frame or the last ~100 ms: a talker's loudest syllable, or the room the moment the caller
    // stops, is still the room.
    this.distant = this.caller.below(db) || this.caller.below(10 * Math.log10(this.shortPower));
    this.aboveFloorMs = db < floor + NEAR_FLOOR_DB ? 0 : this.aboveFloorMs + FRAME_MS;
    const loud = db > floor + MARGIN_DB;
    const tonal = this.tones.observe(samples, delta, loud && this.config.rejectTones);
    this.tonalFrames = tonal ? this.tonalFrames + 1 : 0;
    // Tones and the caller gate keep sound from starting speech; neither cuts the caller off.
    const rejected = !this.run.active ? tonal || this.distant : this.tonalFrames >= RUN_TONE_FRAMES;
    const raw = crossings >= 3 && !rejected ? sigmoid((db - floor - MARGIN_DB) / 3) : 0;
    this.confidenceState =
      this.config.smoothing * this.confidenceState + (1 - this.config.smoothing) * raw;
    const confidence = Math.max(0, Math.min(1, this.confidenceState));

    this.volumeState = 0.1 * this.volumeState + 0.9 * this.normalizedVolume(level(pcm).db);
    const confident = confidence >= this.config.confidence;
    if (!this.run.active) this.heldFrames = 0;
    this.holdVolume = this.run.active && confident && this.holds();
    this.run.observe(confident && (this.holdVolume || this.volumeState >= this.config.minVolume));
    this.caller.observe(db, this.run.active && raw >= 0.5 && !this.distant, floor);
    this.analysed = pcm;

    const speech =
      loud &&
      !tonal &&
      this.modulation >= MODULATED_DB &&
      this.aboveFloorMs <= MAX_FROZEN_MS &&
      !this.distant;
    const tauMs =
      db <= floor ? FLOOR_FALL_MS : speech ? this.config.speechFloorTauMs : FLOOR_RISE_MS;
    this.floor = floor + (1 - Math.exp(-FRAME_MS / tauMs)) * (db - floor);
    return confidence;
  }

  /**
   * The frame's level. Inside an utterance a confident frame reports at least minVolume while it
   * is within the gate of the caller's learned level (or, before that is learned, for 300 ms of
   * the utterance): a quiet caller's soft syllable is still speech, so absolute level alone
   * cannot end it.
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
    this.tonalFrames = 0;
    this.heldFrames = 0;
    this.shortPower = 0;
    this.distant = false;
  }

  /** Whether a confident frame inside an utterance reports at least minVolume. */
  private holds(): boolean {
    if (this.volumeState >= this.config.minVolume) return true;
    if (this.caller.learned) return !this.distant;
    return ++this.heldFrames <= MAX_HELD_FRAMES;
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
