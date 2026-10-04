import type { AudioFormat } from '@winsendotai/ovo-contracts';
import { recordingBytesPerSecond, supportedRecordingFormat } from './capture-types.ts';

/** Header for a mono raw recording track, preserving its captured encoding and rate. */
export function recordingWavHeader(format: AudioFormat, dataBytes: number): Uint8Array {
  if (!supportedRecordingFormat(format)) throw new Error('Unsupported recording audio format');
  const bytesPerSample = format.encoding === 'pcm_s16le' ? 2 : 1;
  const nonPcm = format.encoding === 'mulaw';
  const headerBytes = nonPcm ? 58 : 44;
  if (
    !Number.isSafeInteger(dataBytes) ||
    dataBytes < 0 ||
    dataBytes > 0xffff_ffff - (headerBytes - 8) - (dataBytes % 2) ||
    dataBytes % bytesPerSample !== 0
  )
    throw new Error('Invalid recording WAV data length');
  const header = Buffer.alloc(headerBytes);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(dataBytes + header.byteLength - 8 + (dataBytes % 2), 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(nonPcm ? 18 : 16, 16);
  header.writeUInt16LE(format.encoding === 'pcm_s16le' ? 1 : 7, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(recordingBytesPerSecond(format), 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  if (nonPcm) {
    header.writeUInt16LE(0, 36); // WAVEFORMATEX.cbSize
    header.write('fact', 38, 'ascii');
    header.writeUInt32LE(4, 42);
    header.writeUInt32LE(dataBytes, 46); // one encoded byte per mono sample
  }
  header.write('data', header.byteLength - 8, 'ascii');
  header.writeUInt32LE(dataBytes, header.byteLength - 4);
  return header;
}

export function encodeRecordingWav(format: AudioFormat, audio: Uint8Array): Uint8Array {
  const header = recordingWavHeader(format, audio.byteLength);
  const output = new Uint8Array(header.byteLength + audio.byteLength + (audio.byteLength % 2));
  output.set(header);
  output.set(audio, header.byteLength);
  return output;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  format: 'pcm' | 'mulaw';
  durationMs: number;
}
export const MAX_RECORDING_BYTES = 5 * 1024 * 1024;
/** Validate the actual WAV envelope, not a browser-provided MIME type or duration. */
export function inspectWav(input: Uint8Array): WavInfo {
  const wav = Buffer.from(input);
  if (wav.length < 44 || wav.length > MAX_RECORDING_BYTES)
    throw new Error('Recording must be a WAV of 44 bytes to 5 MiB');
  if (
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) !== wav.length - 8
  )
    throw new Error('Invalid RIFF/WAVE envelope');
  let format: number | undefined,
    channels = 0,
    sampleRate = 0,
    bits = 0,
    byteRate = 0,
    blockAlign = 0,
    dataBytes: number | undefined;
  for (let cursor = 12; cursor < wav.length;) {
    if (cursor + 8 > wav.length) throw new Error('Truncated WAV chunk');
    const size = wav.readUInt32LE(cursor + 4),
      start = cursor + 8,
      end = start + size;
    if (end > wav.length) throw new Error('Truncated WAV data');
    const kind = wav.toString('ascii', cursor, cursor + 4);
    if (kind === 'fmt ') {
      if (format !== undefined || size < 16) throw new Error('Invalid WAV format chunk');
      format = wav.readUInt16LE(start);
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      byteRate = wav.readUInt32LE(start + 8);
      blockAlign = wav.readUInt16LE(start + 12);
      bits = wav.readUInt16LE(start + 14);
    }
    if (kind === 'data') {
      if (dataBytes !== undefined) throw new Error('Multiple WAV data chunks');
      dataBytes = size;
    }
    cursor = end + (size % 2);
    if (cursor > wav.length) throw new Error('Missing WAV alignment padding');
  }
  if (
    ![1, 7].includes(format ?? 0) ||
    ![1, 2].includes(channels) ||
    sampleRate < 8000 ||
    sampleRate > 48000 ||
    dataBytes === undefined ||
    dataBytes === 0
  )
    throw new Error('Unsupported WAV format');
  if (
    (format === 1 && ![8, 16, 24, 32].includes(bits)) ||
    (format === 7 && bits !== 8) ||
    blockAlign !== (channels * bits) / 8 ||
    byteRate !== sampleRate * blockAlign ||
    dataBytes % blockAlign !== 0
  )
    throw new Error('Inconsistent WAV sample format');
  return {
    sampleRate,
    channels,
    bitsPerSample: bits,
    format: format === 1 ? 'pcm' : 'mulaw',
    durationMs: (dataBytes / byteRate) * 1000,
  };
}
