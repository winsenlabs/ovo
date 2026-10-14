// A caller track: a mono WAV the recordings API serves (8 kHz 16-bit PCM decoded from the
// carrier's μ-law, so re-encoding it to μ-law is lossless), or a μ-law WAV.
import { mulawToPcm16, pcm16ToMulaw } from '@winsendotai/ovo-audio';

export interface Pcm {
  sampleRate: number;
  samples: Int16Array;
}

function chunks(file: Uint8Array): Map<string, { at: number; size: number }> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const found = new Map<string, { at: number; size: number }>();
  const name = (at: number) => new TextDecoder('latin1').decode(file.subarray(at, at + 4));
  if (file.byteLength < 12 || name(0) !== 'RIFF' || name(8) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');
  let at = 12;
  while (at + 8 <= file.byteLength) {
    const size = view.getUint32(at + 4, true);
    if (!found.has(name(at))) found.set(name(at), { at: at + 8, size });
    at += 8 + size + (size % 2);
  }
  return found;
}

export function decodeWav(file: Uint8Array): Pcm {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const parts = chunks(file);
  const fmt = parts.get('fmt ');
  const data = parts.get('data');
  if (!fmt || !data) throw new Error('WAV needs fmt and data chunks');
  const [code, channels, sampleRate, bits] = [
    view.getUint16(fmt.at, true),
    view.getUint16(fmt.at + 2, true),
    view.getUint32(fmt.at + 4, true),
    view.getUint16(fmt.at + 14, true),
  ];
  if (channels !== 1) throw new Error(`a caller track is mono; this WAV has ${channels} channels`);
  const end = Math.min(file.byteLength, data.at + data.size);
  if (code === 7 && bits === 8)
    return { sampleRate, samples: mulawToPcm16(file.subarray(data.at, end)) };
  if (code !== 1 || bits !== 16) throw new Error(`unsupported WAV encoding ${code}/${bits}-bit`);
  const samples = new Int16Array((end - data.at) >> 1);
  samples.forEach((_, index) => (samples[index] = view.getInt16(data.at + index * 2, true)));
  return { sampleRate, samples };
}

/** The track as the carrier sends it: 8 kHz μ-law, in `frameMs` frames. */
export function mulawFrames(pcm: Pcm, frameMs = 20): Uint8Array[] {
  if (pcm.sampleRate !== 8000) throw new Error(`caller tracks are 8 kHz, not ${pcm.sampleRate} Hz`);
  const step = (pcm.sampleRate / 1000) * frameMs;
  const frames: Uint8Array[] = [];
  for (let at = 0; at < pcm.samples.length; at += step)
    frames.push(pcm16ToMulaw(pcm.samples.subarray(at, Math.min(pcm.samples.length, at + step))));
  return frames;
}

export function durationMs(pcm: Pcm): number {
  return (pcm.samples.length * 1000) / pcm.sampleRate;
}
