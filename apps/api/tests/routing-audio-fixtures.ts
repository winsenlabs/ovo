/** Hold clip fixtures (Wave 16): WAV uploads as a browser sends them and stored clip inputs. */
import { createHash } from 'node:crypto';

/** A canonical PCM/G.711 WAV: `format` 1 (PCM), 6 (A-law) or 7 (μ-law). */
export function wav(input: {
  format?: number;
  channels?: number;
  rate: number;
  bits?: number;
  data: Uint8Array;
}): Buffer {
  const channels = input.channels ?? 1;
  const bits = input.bits ?? 16;
  const block = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + input.data.byteLength + (input.data.byteLength % 2), 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(input.format ?? 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(input.rate, 24);
  header.writeUInt32LE(input.rate * block, 28);
  header.writeUInt16LE(block, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(input.data.byteLength, 40);
  const pad = Buffer.alloc(input.data.byteLength % 2);
  return Buffer.concat([header, input.data, pad]);
}

/** `seconds` of a 440 Hz tone as interleaved PCM16 (the same tone on every channel). */
function tone(rate: number, seconds: number, channels = 1): Uint8Array {
  const frames = Math.round(rate * seconds);
  const out = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1)
    for (let c = 0; c < channels; c += 1)
      out.writeInt16LE(
        Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)),
        (i * channels + c) * 2,
      );
  return out;
}

export const pcmWav = (rate: number, seconds: number, channels = 1) =>
  wav({ rate, channels, data: tone(rate, seconds, channels) });

/** A stored hold clip's create input: a second of 8 kHz μ-law silence. */
export function clipInput(name: string) {
  const audio = new Uint8Array(8000).fill(0xff);
  return {
    name,
    audio,
    durationMs: 1000,
    sha256: createHash('sha256').update(audio).digest('hex'),
    source: {
      container: 'wav' as const,
      encoding: 'pcm_s16le' as const,
      sampleRate: 8000,
      channels: 1 as const,
    },
    createdBy: 'test',
  };
}
