// An offline speech finder for gold utterances: it sees the whole track, so unlike the call's
// causal VAD it can pick its threshold from the track's own noise floor and look ahead.
import type { Pcm } from './wav.ts';

export interface SpeechRegion {
  /** Track time of the first and last speech frame, padded by `padMs`. */
  startMs: number;
  endMs: number;
  /** Milliseconds of frames above the threshold inside the region. */
  voicedMs: number;
  /** The loudest frame, dBFS. */
  peakDb: number;
}

export interface SpeechOptions {
  frameMs?: number;
  /** Never call anything quieter than this speech, whatever the floor (dBFS). */
  minimumDb?: number;
  /** A frame this far above the noise floor starts speech. */
  aboveFloorDb?: number;
  /** Inside speech, frames stay speech down to this much below the start threshold. */
  hysteresisDb?: number;
  /** Regions with fewer voiced milliseconds are clicks or line noise. */
  minVoicedMs?: number;
  /** A region ends after this much quiet; a shorter pause is a breath inside one utterance. */
  mergeGapMs?: number;
  padMs?: number;
}

const DEFAULTS: Required<SpeechOptions> = {
  frameMs: 20,
  minimumDb: -55,
  aboveFloorDb: 15,
  hysteresisDb: 8,
  minVoicedMs: 120,
  mergeGapMs: 500,
  padMs: 80,
};

/** Each frame's RMS level in dBFS; digital silence is -120. */
export function frameLevels(pcm: Pcm, frameMs = 20): number[] {
  const size = Math.round((pcm.sampleRate * frameMs) / 1000);
  const levels: number[] = [];
  for (let at = 0; at + size <= pcm.samples.length; at += size) {
    let sum = 0;
    for (let i = at; i < at + size; i += 1) sum += pcm.samples[i]! * pcm.samples[i]!;
    const rms = Math.sqrt(sum / size) / 32768;
    levels.push(rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120);
  }
  return levels;
}

/**
 * The line's noise floor: the 20th percentile of frames that are not digital silence. Carrier
 * tracks hold long runs of exact silence between the caller's bursts, which would put any plain
 * percentile at the codec's floor.
 */
export function noiseFloor(levels: readonly number[]): number {
  const live = levels.filter((level) => level > -100).sort((a, b) => a - b);
  return live.length ? live[Math.floor(live.length * 0.2)]! : -120;
}

/** The level that starts speech, and the lower one that holds it, for a track's frame levels. */
export function speechThresholds(
  levels: readonly number[],
  options: SpeechOptions = {},
): { start: number; hold: number } {
  const o = { ...DEFAULTS, ...options };
  const start = Math.max(o.minimumDb, noiseFloor(levels) + o.aboveFloorDb);
  return { start, hold: start - o.hysteresisDb };
}

/** The caller's speech on a track, as padded regions in track time. */
export function speechRegions(pcm: Pcm, options: SpeechOptions = {}): SpeechRegion[] {
  const o = { ...DEFAULTS, ...options };
  const levels = frameLevels(pcm, o.frameMs);
  const { start, hold } = speechThresholds(levels, o);
  const raw: { first: number; last: number; voiced: number; peak: number }[] = [];
  let open: (typeof raw)[number] | undefined;
  for (const [index, level] of levels.entries()) {
    if (!open) {
      if (level >= start) open = { first: index, last: index, voiced: 1, peak: level };
      continue;
    }
    if (level >= hold) {
      open.last = index;
      open.voiced += 1;
      open.peak = Math.max(open.peak, level);
    } else if ((index - open.last) * o.frameMs >= o.mergeGapMs) {
      raw.push(open);
      open = undefined;
    }
  }
  if (open) raw.push(open);
  const trackMs = levels.length * o.frameMs;
  return raw
    .filter((region) => region.voiced * o.frameMs >= o.minVoicedMs)
    .map((region) => ({
      startMs: Math.max(0, region.first * o.frameMs - o.padMs),
      endMs: Math.min(trackMs, (region.last + 1) * o.frameMs + o.padMs),
      voicedMs: region.voiced * o.frameMs,
      peakDb: Math.round(region.peak * 10) / 10,
    }));
}
