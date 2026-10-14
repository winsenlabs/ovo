// A VAD trace: the stretches of the caller track where the energy VAD heard speech, frame by frame
// and before its start/stop debounce (the engine's IngressVad applies that). Taken from the caller
// audio it lets a transcript replay hear the call as the VAD did without the audio itself; a call
// with no audio gets one modelled from its turns, and says so.
import { createEnergyVad } from '@winsendotai/ovo-plugin-vad';
import type { CallerTurn } from '../timeline.ts';
import type { Pcm } from './wav.ts';

export interface VadTrace {
  /** Where the runs come from: `audio` (the energy VAD over the track) or `modelled`. */
  source: 'audio' | 'modelled';
  /** Call time = trace time + offsetMs. */
  offsetMs: number;
  frameMs: number;
  /** [start, end) in trace ms where a frame was a speech candidate. */
  runs: [number, number][];
}

export function parseVadTrace(value: unknown): VadTrace {
  const trace = value as VadTrace;
  if (!trace || !Array.isArray(trace.runs) || typeof trace.frameMs !== 'number')
    throw new Error('a VAD trace needs frameMs and runs');
  return {
    source: trace.source ?? 'audio',
    offsetMs: trace.offsetMs ?? 0,
    frameMs: trace.frameMs,
    runs: trace.runs,
  };
}

/** Runs the energy VAD (row `row`) over the track, as the engine's ingress would frame it. */
export function traceFromPcm(
  pcm: Pcm,
  offsetMs: number,
  row: Record<string, unknown> = {},
): VadTrace {
  if (pcm.sampleRate !== 8000 && pcm.sampleRate !== 16000)
    throw new Error(`the VAD takes 8 or 16 kHz, not ${pcm.sampleRate} Hz`);
  const factory = createEnergyVad(row);
  const analyzer = factory.create(pcm.sampleRate);
  const frameMs = (analyzer.frameSamples * 1000) / pcm.sampleRate;
  const runs: [number, number][] = [];
  let open: number | undefined;
  let frame = 0;
  for (let at = 0; at + analyzer.frameSamples <= pcm.samples.length; at += analyzer.frameSamples) {
    const chunk = pcm.samples.subarray(at, at + analyzer.frameSamples);
    const speech =
      analyzer.confidence(chunk) >= factory.params.confidence &&
      analyzer.volume(chunk) >= factory.params.minVolume;
    const ms = frame++ * frameMs;
    if (speech && open === undefined) open = ms;
    if (!speech && open !== undefined) {
      runs.push([open, ms]);
      open = undefined;
    }
  }
  if (open !== undefined) runs.push([open, frame * frameMs]);
  return { source: 'audio', offsetMs, frameMs, runs };
}

/**
 * A trace modelled from a call's turns, for calls with no audio: the caller spoke from the VAD's
 * start debounce before each turn opened until its last voiced audio (`endpointMs` before its end).
 */
export function traceFromTurns(turns: readonly CallerTurn[], startMs = 200): VadTrace {
  const runs: [number, number][] = [];
  for (const turn of turns) {
    if (turn.endedAtMs === undefined) continue;
    const start = Math.max(0, turn.startedAtMs - startMs);
    const end =
      turn.outcome === 'stopped' && turn.endpointMs !== undefined
        ? turn.endedAtMs - turn.endpointMs
        : turn.endedAtMs;
    if (end > start) runs.push([start, end]);
  }
  runs.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && run[0] <= last[1]) last[1] = Math.max(last[1], run[1]);
    else merged.push([...run]);
  }
  return { source: 'modelled', offsetMs: 0, frameMs: 20, runs: merged };
}

/** Whether the caller was speaking at call time `atMs`. */
export function speakingAt(trace: VadTrace, atMs: number): boolean {
  const at = atMs - trace.offsetMs;
  let low = 0;
  let high = trace.runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = trace.runs[mid]!;
    if (at < start) high = mid - 1;
    else if (at >= end) low = mid + 1;
    else return true;
  }
  return false;
}

/** The trace's speech in call time, merged across gaps shorter than `gapMs`. */
export function speechSpans(trace: VadTrace, gapMs = 0): { startMs: number; endMs: number }[] {
  const spans: { startMs: number; endMs: number }[] = [];
  for (const [start, end] of trace.runs) {
    const last = spans.at(-1);
    const span = { startMs: start + trace.offsetMs, endMs: end + trace.offsetMs };
    if (last && span.startMs - last.endMs <= gapMs) last.endMs = span.endMs;
    else spans.push(span);
  }
  return spans;
}

/**
 * When the engine's VAD would report each start, in trace time: its IngressVad debounce, `startMs`
 * (and `stopMs`) of frames in a row before it changes state.
 */
export function reportedStarts(trace: VadTrace, startMs = 200, stopMs = 200): number[] {
  const toStart = Math.max(1, Math.round(startMs / trace.frameMs));
  const toStop = Math.max(1, Math.round(stopMs / trace.frameMs));
  const frames = Math.ceil((trace.runs.at(-1)?.[1] ?? 0) / trace.frameMs) + toStop;
  const speech = new Uint8Array(frames);
  for (const [start, end] of trace.runs)
    speech.fill(1, Math.round(start / trace.frameMs), Math.round(end / trace.frameMs));
  const starts: number[] = [];
  let active = false;
  let run = 0;
  for (let frame = 0; frame < frames; frame++) {
    if ((speech[frame] === 1) === active) {
      run = 0;
      continue;
    }
    if (++run < (active ? toStop : toStart)) continue;
    active = !active;
    run = 0;
    // Stamped when the frame completing the debounce arrives, as a replay's carrier delivers it.
    if (active) starts.push((frame + 1) * trace.frameMs);
  }
  return starts;
}

/**
 * The caller track's offset on the call timeline (call time = track time + offset). The recording's
 * own alignment is "not waveform-synchronized" (calls 7 and 8 were about 1 s out), so it is read off
 * the audio: the offset most of the call's turn starts agree with, each turn started by the VAD
 * `startMs` after speech began. Null when fewer than three turns agree within 30 ms.
 */
export function estimateOffset(
  trace: VadTrace,
  turnStarts: readonly number[],
  startMs = 200,
): { offsetMs: number; agreeing: number } | null {
  const starts = reportedStarts(trace, startMs);
  const candidates = turnStarts.flatMap((turn) =>
    starts.map((start) => Math.round(turn - start)).filter((offset) => Math.abs(offset) <= 3000),
  );
  let best: { offsetMs: number; agreeing: number } | null = null;
  for (const offset of candidates) {
    const near = candidates.filter((other) => Math.abs(other - offset) <= 30);
    if (!best || near.length > best.agreeing) {
      const sorted = near.sort((a, b) => a - b);
      best = { offsetMs: sorted[sorted.length >> 1]!, agreeing: near.length };
    }
  }
  return best && best.agreeing >= 3 ? best : null;
}
