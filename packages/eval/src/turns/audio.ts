import { createEnergyVad, PHONE_VAD_CONFIG } from '../../../plugin-vad/src/index.ts';
import type { LiveTurn, Timeline } from './timeline.ts';

/** A 16-bit PCM mono WAV (the corpus's callN-caller.wav: 8 kHz, decoded from the carrier μ-law). */
export function readWav(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      const format = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      const bits = view.getUint16(offset + 22, true);
      if (format !== 1 || channels !== 1 || bits !== 16)
        throw new Error('expected 16-bit PCM mono');
    } else if (id === 'data') {
      const length = Math.min(size, bytes.length - offset - 8) >> 1;
      const pcm = new Int16Array(length);
      for (let i = 0; i < length; i++) pcm[i] = view.getInt16(offset + 8 + i * 2, true);
      return { pcm, sampleRate };
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

export const FRAME_SAMPLES = 160;
export const FRAME_MS = 20;

/**
 * The production VAD (plugin-vad's energy VAD, PHONE_VAD_CONFIG) over 8 kHz caller audio, its
 * start/stop counted as the engine's IngressVad does: each transition is timed at the start of the
 * frame that completed it. Times are ms from the first sample.
 */
export function vadTransitions(pcm: Int16Array): { at: number; type: 'vad.start' | 'vad.stop' }[] {
  const factory = createEnergyVad(PHONE_VAD_CONFIG);
  const analyzer = factory.create(8000);
  const { confidence: minConfidence, minVolume, startMs, stopMs } = factory.params;
  const startFrames = Math.max(1, Math.round(startMs / FRAME_MS));
  const stopFrames = Math.max(1, Math.round(stopMs / FRAME_MS));
  const out: { at: number; type: 'vad.start' | 'vad.stop' }[] = [];
  let active = false;
  let consecutive = 0;
  for (let frame = 0; (frame + 1) * FRAME_SAMPLES <= pcm.length; frame++) {
    const samples = pcm.subarray(frame * FRAME_SAMPLES, (frame + 1) * FRAME_SAMPLES);
    const candidate =
      analyzer.confidence(samples) >= minConfidence && analyzer.volume(samples) >= minVolume;
    if (candidate === active) {
      consecutive = 0;
      continue;
    }
    if (++consecutive < (candidate ? startFrames : stopFrames)) continue;
    active = candidate;
    consecutive = 0;
    out.push({ at: frame * FRAME_MS, type: candidate ? 'vad.start' : 'vad.stop' });
  }
  if (active) out.push({ at: Math.floor(pcm.length / FRAME_SAMPLES) * FRAME_MS, type: 'vad.stop' });
  return out;
}

/**
 * Where the audio's first sample falls on the call's timeline: the offset at which the most live
 * turns that the VAD opened (a turn started before its first words) start within 60 ms of a VAD
 * start in the audio. The live engine ran the same VAD on the same audio, so the right offset
 * lines nearly all of them up. Searched from -3 s to +3 s in 10 ms steps.
 */
export function alignAudio(
  starts: readonly number[],
  live: readonly LiveTurn[],
  transcripts: Timeline['transcripts'],
): { offsetMs: number; matched: number; candidates: number } {
  const opened = live
    .filter((turn) => {
      const first = transcripts.find((t) => t.at >= turn.startedAt - 5);
      return !first || first.at > turn.startedAt + 100;
    })
    .map((turn) => turn.startedAt);
  let best = { offsetMs: 0, matched: -1, error: Infinity };
  for (let offset = -3000; offset <= 3000; offset += 10) {
    let matched = 0;
    let error = 0;
    for (const at of opened) {
      const near = starts.reduce((d, s) => Math.min(d, Math.abs(s + offset - at)), Infinity);
      if (near <= 60) {
        matched++;
        error += near;
      }
    }
    if (matched > best.matched || (matched === best.matched && error < best.error))
      best = { offsetMs: offset, matched, error };
  }
  return { offsetMs: best.offsetMs, matched: best.matched, candidates: opened.length };
}
