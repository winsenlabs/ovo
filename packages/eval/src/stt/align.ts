// Puts the caller track on the call's event timeline. The recordings API says its alignment is
// "not-waveform-synchronized", so the offset is estimated from the audio itself: the call's VAD
// started each user turn a fixed delay after the caller's first speech frame.
import type { CallLog, ProductionFinal, UserTurn } from './call-log.ts';
import type { SpeechRegion } from './vad.ts';

/** The production VAD's `startMs` (VadParams default): speech this long opens a user turn. */
export const VAD_START_MS = 200;

export interface Alignment {
  /** Call time = track time + offsetMs. */
  offsetMs: number;
  /** Turn starts within 400 ms of a predicted onset, of all turn starts. */
  matched: number;
  turns: number;
  /** Median distance of the matched turn starts from their predicted onset. */
  medianErrorMs: number;
}

/**
 * The offset that best explains the turn starts: each `user.turn` start sits `vadStartMs` after a
 * speech onset. Every onset-to-start pairing proposes an offset; the one with the smallest total
 * (capped) distance wins, so turns that the VAD opened on noise do not drag it.
 */
export function alignTrack(
  regions: readonly SpeechRegion[],
  turns: readonly UserTurn[],
  padMs: number,
  vadStartMs = VAD_START_MS,
): Alignment {
  const onsets = regions.map((region) => region.startMs + padMs + vadStartMs);
  const starts = turns.map((turn) => turn.startedMs);
  const cost = (offset: number) =>
    starts.reduce(
      (sum, start) =>
        sum + Math.min(1000, ...onsets.map((onset) => Math.abs(start - (onset + offset)))),
      0,
    );
  let best = { offset: 0, cost: Infinity };
  for (const start of starts)
    for (const onset of onsets) {
      const offset = Math.round(start - onset);
      if (Math.abs(offset) > 5000) continue;
      const total = cost(offset);
      if (total < best.cost) best = { offset, cost: total };
    }
  const errors = starts
    .map((start) => Math.min(...onsets.map((onset) => Math.abs(start - (onset + best.offset)))))
    .filter((error) => error <= 400)
    .sort((a, b) => a - b);
  return {
    offsetMs: best.offset,
    matched: errors.length,
    turns: starts.length,
    medianErrorMs: errors.length ? errors[Math.floor(errors.length / 2)]! : NaN,
  };
}

export interface DraftUtterance {
  id: string;
  /** On the caller track. */
  audioStartMs: number;
  audioEndMs: number;
  /** On the call's event timeline (ms since session.started). */
  startMs: number;
  endMs: number;
  voicedMs: number;
  peakDb: number;
  /** User turns open while this utterance was spoken. */
  productionTurnIds: string[];
  /** The production STT's finals that arrived for this stretch of speech. */
  productionFinals: ProductionFinal[];
}

/**
 * One draft utterance per speech region, with the turns and production finals that belong to it:
 * a turn overlaps it on the call timeline; a final arrives after it starts and before the next
 * region does (finals trail the speech by the commit's round trip).
 */
export function draftUtterances(
  prefix: string,
  regions: readonly SpeechRegion[],
  log: CallLog,
  alignment: Alignment,
): DraftUtterance[] {
  return regions.map((region, index) => {
    const startMs = region.startMs + alignment.offsetMs;
    const endMs = region.endMs + alignment.offsetMs;
    const nextStart = regions[index + 1]
      ? regions[index + 1]!.startMs + alignment.offsetMs
      : Infinity;
    return {
      id: `${prefix}-u${String(index + 1).padStart(2, '0')}`,
      audioStartMs: region.startMs,
      audioEndMs: region.endMs,
      startMs,
      endMs,
      voicedMs: region.voicedMs,
      peakDb: region.peakDb,
      productionTurnIds: log.turns
        .filter((turn) => turn.startedMs < endMs && (turn.stoppedMs ?? Infinity) > startMs)
        .map((turn) => turn.turnId),
      productionFinals: log.finals.filter(
        (final) => final.atMs > startMs && final.atMs <= nextStart,
      ),
    };
  });
}

export interface UnheardTurn {
  turn: UserTurn;
  /** A window on the caller track that covers what the live STT was answering. */
  audioStartMs: number;
  audioEndMs: number;
}

/**
 * User turns the live call held where the speech finder heard no caller: the live STT turned
 * line noise or near-silence into words (call 8: "Question 4.", "Hıhı."). Turns opened by a late
 * transcript (started and stopped together) are not counted; they belong to the speech before.
 * Each gets a window from `leadMs` before the turn opened to its stop, kept clear of speech and
 * of the window before.
 */
export function unheardTurns(
  log: CallLog,
  regions: readonly SpeechRegion[],
  alignment: Alignment,
  leadMs = 2_000,
): UnheardTurn[] {
  const unheard: UnheardTurn[] = [];
  for (const turn of log.turns) {
    const stopped = turn.stoppedMs ?? turn.startedMs;
    if (stopped - turn.startedMs < 300) continue;
    const start = turn.startedMs - alignment.offsetMs;
    const end = stopped - alignment.offsetMs;
    // A turn opening within 300 ms of speech is that speech's (the VAD's start delay).
    if (regions.some((region) => region.startMs < end && region.endMs + 300 > start)) continue;
    const before = Math.max(
      regions.filter((region) => region.endMs <= start).at(-1)?.endMs ?? 0,
      unheard.at(-1)?.audioEndMs ?? 0,
    );
    if (end - before < 300) continue;
    unheard.push({ turn, audioStartMs: Math.max(before, start - leadMs), audioEndMs: end });
  }
  return unheard;
}
