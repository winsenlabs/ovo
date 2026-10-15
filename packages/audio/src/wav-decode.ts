/**
 * Strict RIFF/WAVE reader for operator-uploaded clips (Wave 16 hold audio). Accepts PCM 16-bit
 * little-endian, PCM 8-bit unsigned, μ-law and A-law (plain or WAVE_FORMAT_EXTENSIBLE), mono or
 * stereo, 8-48 kHz. Every chunk size is bounded by the file; `LIST`, `fact` and other chunks are
 * skipped with their odd-size padding. Nothing is guessed: a truncated or inconsistent file throws.
 */
import { ALAW_DECODE, MULAW_DECODE } from './g711.ts';

export type WavEncoding = 'pcm_s16le' | 'pcm_u8' | 'mulaw' | 'alaw';

export interface DecodedWav {
  encoding: WavEncoding;
  sampleRate: number;
  channels: 1 | 2;
  /** Samples per channel. */
  frames: number;
  /** One PCM16 array per channel, de-interleaved. */
  samples: Int16Array[];
}

/** `unsupported`: not RIFF/WAVE, or an encoding/layout outside the list; `invalid`: malformed. */
export class WavDecodeError extends Error {
  constructor(
    readonly kind: 'unsupported' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'WavDecodeError';
  }
}

export const WAV_MIN_RATE = 8000;
export const WAV_MAX_RATE = 48000;

const FORMAT_PCM = 1;
const FORMAT_ALAW = 6;
const FORMAT_MULAW = 7;
const FORMAT_EXTENSIBLE = 0xfffe;
/** The KSDATAFORMAT_SUBTYPE GUID tail every WAVE_FORMAT_EXTENSIBLE sub-format shares. */
const SUBTYPE_TAIL = [
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

const invalid = (message: string) => new WavDecodeError('invalid', message);
const unsupported = (message: string) => new WavDecodeError('unsupported', message);

interface Format {
  encoding: WavEncoding;
  channels: 1 | 2;
  sampleRate: number;
  blockAlign: number;
}

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** The sub-format tag of an extensible `fmt ` chunk, after its own consistency checks. */
function extensibleTag(view: DataView, bytes: Uint8Array, at: number, size: number, bits: number) {
  if (size < 40 || view.getUint16(at + 16, true) < 22)
    throw invalid('WAVE_FORMAT_EXTENSIBLE needs a 22-byte extension');
  const valid = view.getUint16(at + 18, true);
  if (valid !== 0 && valid !== bits)
    throw unsupported(`${valid} valid bits in ${bits}-bit samples`);
  for (let i = 0; i < SUBTYPE_TAIL.length; i += 1)
    if (bytes[at + 26 + i] !== SUBTYPE_TAIL[i]) throw unsupported('Unknown extensible sub-format');
  return view.getUint16(at + 24, true);
}

function readFormat(view: DataView, bytes: Uint8Array, at: number, size: number): Format {
  if (size < 16) throw invalid('The fmt chunk is shorter than 16 bytes');
  let tag = view.getUint16(at, true);
  const channels = view.getUint16(at + 2, true);
  const sampleRate = view.getUint32(at + 4, true);
  const byteRate = view.getUint32(at + 8, true);
  const blockAlign = view.getUint16(at + 12, true);
  const bits = view.getUint16(at + 14, true);
  if (tag === FORMAT_EXTENSIBLE) tag = extensibleTag(view, bytes, at, size, bits);
  let encoding: WavEncoding;
  if (tag === FORMAT_PCM && bits === 16) encoding = 'pcm_s16le';
  else if (tag === FORMAT_PCM && bits === 8) encoding = 'pcm_u8';
  else if (tag === FORMAT_MULAW || tag === FORMAT_ALAW) {
    if (bits !== 8) throw invalid(`G.711 samples are 8-bit, not ${bits}-bit`);
    encoding = tag === FORMAT_MULAW ? 'mulaw' : 'alaw';
  } else throw unsupported(`Unsupported WAV encoding ${tag}/${bits}-bit`);
  if (channels !== 1 && channels !== 2)
    throw unsupported(`${channels} channels; use mono or stereo`);
  if (sampleRate < WAV_MIN_RATE || sampleRate > WAV_MAX_RATE)
    throw unsupported(`${sampleRate} Hz is outside ${WAV_MIN_RATE}-${WAV_MAX_RATE} Hz`);
  if (blockAlign !== (channels * bits) / 8) throw invalid('Block alignment does not match');
  if (byteRate !== sampleRate * blockAlign) throw invalid('Byte rate does not match');
  return { encoding, channels, sampleRate, blockAlign };
}

function deinterleave(view: DataView, at: number, frames: number, format: Format): Int16Array[] {
  const samples = Array.from({ length: format.channels }, () => new Int16Array(frames));
  const width = format.encoding === 'pcm_s16le' ? 2 : 1;
  const table = format.encoding === 'mulaw' ? MULAW_DECODE : ALAW_DECODE;
  for (let frame = 0; frame < frames; frame += 1)
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = at + frame * format.blockAlign + channel * width;
      const out = samples[channel]!;
      if (format.encoding === 'pcm_s16le') out[frame] = view.getInt16(offset, true);
      else if (format.encoding === 'pcm_u8') out[frame] = (view.getUint8(offset) - 128) << 8;
      else out[frame] = table[view.getUint8(offset)]!;
    }
  return samples;
}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.byteLength < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE')
    throw unsupported('Not a RIFF/WAVE file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = 8 + view.getUint32(4, true);
  // The last chunk's pad byte may be counted but not written; anything else is a size mismatch.
  if (riffEnd > bytes.byteLength + 1)
    throw invalid('The file is shorter than its RIFF header says');
  if (riffEnd < bytes.byteLength) throw invalid('Bytes follow the end of the RIFF chunk');
  let format: Format | undefined;
  let data: { at: number; size: number } | undefined;
  let cursor = 12;
  while (cursor < bytes.byteLength) {
    if (cursor + 8 > bytes.byteLength) throw invalid('Truncated chunk header');
    const id = ascii(bytes, cursor);
    const size = view.getUint32(cursor + 4, true);
    const start = cursor + 8;
    if (start + size > bytes.byteLength)
      throw invalid(id === 'data' ? 'Truncated data chunk' : 'Truncated chunk');
    if (id === 'fmt ') {
      if (format) throw invalid('More than one fmt chunk');
      format = readFormat(view, bytes, start, size);
    } else if (id === 'data') {
      if (data) throw invalid('More than one data chunk');
      if (!format) throw invalid('The data chunk comes before the fmt chunk');
      data = { at: start, size };
    }
    cursor = start + size + (size % 2);
  }
  // Past the end only by an unwritten pad byte, whether or not the RIFF size counted it.
  const padOmitted = cursor === bytes.byteLength + 1 && riffEnd === bytes.byteLength;
  if (cursor !== riffEnd && !padOmitted)
    throw invalid('Chunk sizes do not add up to the RIFF size');
  if (!format) throw invalid('No fmt chunk');
  if (!data) throw invalid('No data chunk');
  if (data.size % format.blockAlign !== 0) throw invalid('Data is not a whole number of frames');
  const frames = data.size / format.blockAlign;
  return {
    encoding: format.encoding,
    sampleRate: format.sampleRate,
    channels: format.channels,
    frames,
    samples: deinterleave(view, data.at, frames, format),
  };
}

/** One channel: the average of left and right (rounded toward negative infinity). */
export function downmixToMono(wav: Pick<DecodedWav, 'samples'>): Int16Array {
  const [left, right] = wav.samples;
  if (!right) return left!;
  const out = new Int16Array(left!.length);
  for (let i = 0; i < out.length; i += 1) out[i] = (left![i]! + right[i]!) >> 1;
  return out;
}
