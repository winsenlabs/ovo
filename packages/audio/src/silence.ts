import { bytesPerSecond, type AudioEncoding, type AudioFormat } from '@winsendotai/ovo-contracts';

/** The byte that encodes digital silence: μ-law 0xFF, A-law 0xD5, PCM 0x00. */
export function silenceByte(encoding: AudioEncoding): number {
  return encoding === 'mulaw' ? 0xff : encoding === 'alaw' ? 0xd5 : 0x00;
}

/** Whole-sample byte count for `ms` of audio in `format`. */
export function bytesForMs(format: AudioFormat, ms: number): number {
  const bytesPerSample = format.encoding === 'pcm_s16le' ? 2 : 1;
  const samples = Math.round((format.sampleRate * ms) / 1000);
  return samples * bytesPerSample * format.channels;
}

/** Milliseconds of audio in `bytes` of `format`. */
export function msForBytes(format: AudioFormat, bytes: number): number {
  return (bytes / bytesPerSecond(format)) * 1000;
}

export function silence(format: AudioFormat, ms: number): Uint8Array {
  return new Uint8Array(bytesForMs(format, ms)).fill(silenceByte(format.encoding));
}

/** Pads `bytes` with silence up to `length` (a no-op when already long enough). */
export function padWithSilence(bytes: Uint8Array, length: number, format: AudioFormat): Uint8Array {
  if (bytes.byteLength >= length) return bytes;
  const out = new Uint8Array(length).fill(silenceByte(format.encoding));
  out.set(bytes);
  return out;
}

/** Root-mean-square level of PCM16 in dBFS (−Infinity for digital silence). */
export function rmsDbfs(pcm: Int16Array): number {
  if (pcm.length === 0) return -Infinity;
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  const rms = Math.sqrt(sum / pcm.length) / 32768;
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}
