// Reads the corpus's mono WAV files into the telephony formats OVO streams.
import {
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  type AudioFormat,
} from '../../packages/contracts/src/index.ts';

export interface Audio {
  format: AudioFormat;
  bytes: Uint8Array;
}

/** A mono WAV: 8 kHz mu-law (format 7), or 16-bit PCM (format 1) at 8 or 16 kHz. */
export function readWav(file: Uint8Array): Audio {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (at: number) => new TextDecoder().decode(file.subarray(at, at + 4));
  if (file.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');
  let format: AudioFormat | undefined;
  for (let at = 12; at + 8 <= file.byteLength;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      const code = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const rate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (channels !== 1) throw new Error(`WAV has ${channels} channels; the corpus is mono`);
      if (code === 7 && bits === 8 && rate === 8000) format = MULAW_8K;
      else if (code === 1 && bits === 16 && rate === 8000) format = PCM16_8K;
      else if (code === 1 && bits === 16 && rate === 16000) format = PCM16_16K;
      else throw new Error(`unsupported WAV format ${code}/${bits}-bit/${rate} Hz`);
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data chunk before its fmt chunk');
      return { format, bytes: file.slice(body, body + size) };
    }
    at = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
