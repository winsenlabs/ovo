/** Batch transcription's RIFF envelope; streaming TTS never uses this path. */
export function createMonoWav(
  audio: Uint8Array,
  codec: 'audio/x-mulaw' | 'audio/pcm',
  sampleRate: 8000 | 24000,
): Uint8Array {
  if (codec === 'audio/pcm' && audio.byteLength % 2)
    throw new TypeError('PCM audio must contain complete signed 16-bit samples');
  const mulaw = codec === 'audio/x-mulaw';
  const header = mulaw ? 58 : 44;
  const result = new Uint8Array(header + audio.byteLength);
  const view = new DataView(result.buffer);
  write(result, 0, 'RIFF');
  view.setUint32(4, result.byteLength - 8, true);
  write(result, 8, 'WAVE');
  write(result, 12, 'fmt ');
  view.setUint32(16, mulaw ? 18 : 16, true);
  view.setUint16(20, mulaw ? 7 : 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  const bytesPerSample = mulaw ? 1 : 2;
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, mulaw ? 8 : 16, true);
  if (mulaw) {
    view.setUint16(36, 0, true);
    write(result, 38, 'fact');
    view.setUint32(42, 4, true);
    view.setUint32(46, audio.byteLength, true);
    write(result, 50, 'data');
    view.setUint32(54, audio.byteLength, true);
  } else {
    write(result, 36, 'data');
    view.setUint32(40, audio.byteLength, true);
  }
  result.set(audio, header);
  return result;
}

function write(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1)
    bytes[offset + index] = value.charCodeAt(index);
}
