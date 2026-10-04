import type { AudioFormat } from '@winsendotai/ovo-contracts';
import { decodeBase64 } from '@winsendotai/ovo-plugin-kit';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Sarvam REST may wrap the requested native codec in a RIFF/WAVE envelope. */
export function decodeRestAudio(encoded: string, requested: AudioFormat): Uint8Array {
  const audio = decodeBase64(encoded);
  if (!audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES)
    throw new Error('Sarvam TTS REST returned an invalid audio size');
  if (fourcc(audio, 0) !== 'RIFF') {
    if (requested.encoding === 'pcm_s16le' && audio.byteLength % 2)
      throw new Error('Sarvam TTS REST returned an incomplete PCM sample');
    return audio;
  }
  if (audio.byteLength < 44 || fourcc(audio, 8) !== 'WAVE')
    throw new Error('Sarvam TTS REST returned an invalid WAV envelope');
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (view.getUint32(4, true) !== audio.byteLength - 8)
    throw new Error('Sarvam TTS REST returned an invalid WAV length');
  let format: number | undefined;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bits: number | undefined;
  let data: Uint8Array | undefined;
  for (let at = 12; at < audio.byteLength;) {
    if (at + 8 > audio.byteLength) throw new Error('Sarvam TTS REST returned a truncated WAV');
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    const end = start + size;
    if (end > audio.byteLength) throw new Error('Sarvam TTS REST returned a truncated WAV');
    switch (fourcc(audio, at)) {
      case 'fmt ':
        if (format !== undefined || size < 16)
          throw new Error('Sarvam TTS REST returned an invalid WAV format');
        format = view.getUint16(start, true);
        channels = view.getUint16(start + 2, true);
        sampleRate = view.getUint32(start + 4, true);
        bits = view.getUint16(start + 14, true);
        break;
      case 'data':
        if (data) throw new Error('Sarvam TTS REST returned multiple WAV data chunks');
        data = audio.slice(start, end);
        break;
    }
    at = end + (size % 2);
    if (at > audio.byteLength) throw new Error('Sarvam TTS REST returned a truncated WAV');
  }
  const code = requested.encoding === 'mulaw' ? 7 : 1;
  const width = requested.encoding === 'mulaw' ? 8 : 16;
  if (
    format !== code ||
    channels !== requested.channels ||
    sampleRate !== requested.sampleRate ||
    bits !== width ||
    !data?.byteLength ||
    data.byteLength % (width / 8)
  )
    throw new Error('Sarvam TTS REST WAV does not match the requested native format');
  return data;
}
