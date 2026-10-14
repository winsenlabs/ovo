// Caller-track WAVs as PCM, cut by milliseconds and re-encoded to the carrier's 8 kHz μ-law.
import { mulawToPcm16, pcm16ToMulaw } from '../../../audio/src/index.ts';

/** Mono PCM samples at their sample rate. */
export interface Pcm {
  sampleRate: number;
  samples: Int16Array;
}

/**
 * A mono WAV: 16-bit PCM (format 1) or μ-law (format 7). The recordings API serves each track as
 * 8 kHz 16-bit PCM decoded from the carrier's μ-law, so re-encoding it is lossless.
 */
export function readWav(file: Uint8Array): Pcm {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (at: number) => String.fromCharCode(...file.subarray(at, at + 4));
  if (file.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');
  let code = 0;
  let sampleRate = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= file.byteLength;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      code = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (channels !== 1) throw new Error(`WAV has ${channels} channels; a caller track is mono`);
    } else if (id === 'data') {
      const end = Math.min(file.byteLength, body + size);
      if (code === 1 && bits === 16) {
        const samples = new Int16Array(Math.floor((end - body) / 2));
        for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(body + i * 2, true);
        return { sampleRate, samples };
      }
      if (code === 7 && bits === 8)
        return { sampleRate, samples: mulawToPcm16(file.subarray(body, end)) };
      throw new Error(`unsupported WAV format ${code}/${bits}-bit`);
    }
    at = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export function durationMs(pcm: Pcm): number {
  return (pcm.samples.length / pcm.sampleRate) * 1000;
}

/** The samples between two times, clamped to the track. */
export function slicePcm(pcm: Pcm, startMs: number, endMs: number): Pcm {
  const at = (ms: number) =>
    Math.max(0, Math.min(pcm.samples.length, Math.round((ms / 1000) * pcm.sampleRate)));
  return { sampleRate: pcm.sampleRate, samples: pcm.samples.slice(at(startMs), at(endMs)) };
}

/** 8 kHz μ-law, what Twilio sends and what OVO streams to STT. */
export function toMulaw8k(pcm: Pcm): Uint8Array {
  if (pcm.sampleRate !== 8000) throw new Error(`expected an 8 kHz track, got ${pcm.sampleRate} Hz`);
  return pcm16ToMulaw(pcm.samples);
}

/** A 16-bit PCM mono WAV file, for batch APIs that take a file upload. */
export function writeWav(pcm: Pcm): Uint8Array<ArrayBuffer> {
  const data = pcm.samples.length * 2;
  const file = new Uint8Array(44 + data);
  const view = new DataView(file.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) file[at + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data, true);
  for (let i = 0; i < pcm.samples.length; i += 1) view.setInt16(44 + i * 2, pcm.samples[i]!, true);
  return file;
}
