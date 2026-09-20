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
