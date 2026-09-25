export type AudioEncoding = 'mulaw' | 'alaw' | 'pcm_s16le';

export interface AudioFormat {
  encoding: AudioEncoding;
  sampleRate: 8000 | 16000 | 22050 | 24000 | 48000;
  channels: 1;
}

export const MULAW_8K: AudioFormat = Object.freeze({
  encoding: 'mulaw',
  sampleRate: 8000,
  channels: 1,
});
export const PCM16_8K: AudioFormat = Object.freeze({
  encoding: 'pcm_s16le',
  sampleRate: 8000,
  channels: 1,
});
export const PCM16_16K: AudioFormat = Object.freeze({
  encoding: 'pcm_s16le',
  sampleRate: 16000,
  channels: 1,
});
export const PCM16_24K: AudioFormat = Object.freeze({
  encoding: 'pcm_s16le',
  sampleRate: 24000,
  channels: 1,
});

/** mulaw/alaw carry one byte per sample; pcm_s16le carries two. Mono only. */
export function bytesPerSecond(format: AudioFormat): number {
  const bytesPerSample = format.encoding === 'pcm_s16le' ? 2 : 1;
  return format.sampleRate * bytesPerSample * format.channels;
}

export function sameFormat(a: AudioFormat, b: AudioFormat): boolean {
  return a.encoding === b.encoding && a.sampleRate === b.sampleRate && a.channels === b.channels;
}
