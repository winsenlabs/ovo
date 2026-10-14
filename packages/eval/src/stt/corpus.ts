// A call in the corpus: its caller track and event log, cut into the gold utterances and into the
// windows the bake-off streams.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  alignTrack,
  draftUtterances,
  unheardTurns,
  type Alignment,
  type DraftUtterance,
  type UnheardTurn,
} from './align.ts';
import { parseCallLog, type CallLog } from './call-log.ts';
import type { GoldUtterance } from './gold.ts';
import { FRAME_MS, type StreamUtterance } from './stream.ts';
import { vadStops } from './production-vad.ts';
import { speechRegions } from './vad.ts';
import { readWav, slicePcm, toMulaw8k, type Pcm } from './wav.ts';

/** How the gold utterances were cut; recorded in each gold file. */
export const SEGMENTATION = {
  /** A pause this long ends an utterance; shorter ones are breaths inside it. */
  mergeGapMs: 400,
  padMs: 80,
  /** Finer regions (the live VAD's 200 ms stop) give the onsets the alignment fits. */
  alignGapMs: 200,
  /** Audio streamed before each utterance, so no provider hears speech start cold. */
  leadMs: 200,
} as const;

/** The VAD's default stopMs: a commit this long after speech the live VAD never stopped on. */
export const FALLBACK_COMMIT_MS = 200;

export interface CorpusCall {
  call: string;
  pcm: Pcm;
  log: CallLog;
  alignment: Alignment;
  drafts: DraftUtterance[];
  /** Live user turns over stretches where the caller said nothing (STT hallucination). */
  unheard: UnheardTurn[];
}

/** Reads `<dir>/<call>-caller.wav` and `<dir>/<call>-events.jsonl`, then segments and aligns. */
export async function loadCall(dir: string, call: string): Promise<CorpusCall> {
  const pcm = readWav(new Uint8Array(await readFile(join(dir, `${call}-caller.wav`))));
  const log = parseCallLog(await readFile(join(dir, `${call}-events.jsonl`), 'utf8'));
  const regions = speechRegions(pcm, {
    mergeGapMs: SEGMENTATION.mergeGapMs,
    padMs: SEGMENTATION.padMs,
  });
  const onsets = speechRegions(pcm, {
    mergeGapMs: SEGMENTATION.alignGapMs,
    padMs: SEGMENTATION.padMs,
  });
  const alignment = alignTrack(onsets, log.turns, SEGMENTATION.padMs);
  const prefix = call.replace(/^call/, 'c');
  return {
    call,
    pcm,
    log,
    alignment,
    drafts: draftUtterances(prefix, regions, log, alignment),
    unheard: unheardTurns(log, regions, alignment),
  };
}

/**
 * The windows to stream for these regions (in track order): the lead-in and the speech, re-encoded to 8 kHz
 * μ-law, with the commits the live VAD would have made (`vadStops` of the whole track) inside or
 * just after each. Where that VAD never stopped after the speech (quiet speech it missed), the
 * window still commits `FALLBACK_COMMIT_MS` after the speech ends, so the STT is measured anyway.
 */
export function streamWindows(
  pcm: Pcm,
  utterances: readonly Pick<GoldUtterance, 'id' | 'audioStartMs' | 'audioEndMs'>[],
  stops: readonly number[] = vadStops(pcm),
): StreamUtterance[] {
  return utterances.map((utterance, index) => {
    // The lead-in never reaches back into the region before: its words are not this one's.
    const floor = Math.max(0, utterances[index - 1]?.audioEndMs ?? 0);
    const startMs =
      Math.ceil(Math.max(floor, utterance.audioStartMs - SEGMENTATION.leadMs) / FRAME_MS) *
      FRAME_MS;
    const endMs = Math.ceil(utterance.audioEndMs / FRAME_MS) * FRAME_MS;
    const speechEndMs = utterance.audioEndMs - SEGMENTATION.padMs - startMs;
    const next = utterances[index + 1]?.audioStartMs ?? Infinity;
    const commitAtMs = stops
      .filter((stop) => stop > startMs && stop < Math.min(next, endMs + 1_000))
      .map((stop) => Math.round(stop - startMs));
    // A VAD stop up to 300 ms before the gold end already closed the speech (the rest is breath).
    if (!commitAtMs.some((at) => at >= speechEndMs - 300))
      commitAtMs.push(Math.round(speechEndMs + FALLBACK_COMMIT_MS));
    return {
      id: utterance.id,
      audio: toMulaw8k(slicePcm(pcm, startMs, endMs)),
      commitAtMs,
      speechEndMs,
    };
  });
}

/** Milliseconds a live pass will stream at most: every window plus its longest wait. */
export function plannedStreamMs(windows: readonly StreamUtterance[], maxWaitMs: number): number {
  return windows.reduce((sum, window) => sum + window.audio.byteLength / 8 + maxWaitMs, 0);
}
