/**
 * ITU-T G.711 μ-law and A-law companding, table driven. Decoding follows the reference algorithm
 * (Sun g711.c); μ-law codes 0x7F and 0xFF both decode to 0, so 0 always encodes to 0xFF.
 */

const BIAS = 0x84;
const CLIP = 32635;
/** A-law segment ends for the 13-bit magnitude. */
const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

function alawSegment(value: number): number {
  for (let segment = 0; segment < ALAW_SEG_END.length; segment += 1)
    if (value <= ALAW_SEG_END[segment]!) return segment;
  return ALAW_SEG_END.length;
}

function mulawDecodeRaw(code: number): number {
  const u = ~code & 0xff;
  let t = ((u & 0x0f) << 3) + BIAS;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? BIAS - t : t - BIAS;
}

function mulawEncodeRaw(sample: number): number {
  let pcm = sample;
  let mask: number;
  if (pcm < 0) {
    pcm = -pcm;
    mask = 0x7f;
  } else mask = 0xff;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exponent = 7;
  for (let bit = 0x4000; (pcm & bit) === 0 && exponent > 0; bit >>= 1) exponent -= 1;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ((exponent << 4) | mantissa) ^ mask;
}

function alawDecodeRaw(code: number): number {
  const a = code ^ 0x55;
  let t = (a & 0x0f) << 4;
  const segment = (a & 0x70) >> 4;
  if (segment === 0) t += 8;
  else if (segment === 1) t += 0x108;
  else t = (t + 0x108) << (segment - 1);
  return a & 0x80 ? t : -t;
}

function alawEncodeRaw(sample: number): number {
  let pcm = sample >> 3;
  let mask: number;
  if (pcm >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  const segment = alawSegment(pcm);
  if (segment >= 8) return 0x7f ^ mask;
  let value = segment << 4;
  value |= segment < 2 ? (pcm >> 1) & 0x0f : (pcm >> segment) & 0x0f;
  return value ^ mask;
}

function decodeTable(decode: (code: number) => number): Int16Array {
  const table = new Int16Array(256);
  for (let code = 0; code < 256; code += 1) table[code] = decode(code);
  return table;
}

function encodeTable(encode: (sample: number) => number): Uint8Array {
  const table = new Uint8Array(65536);
  for (let sample = -32768; sample < 32768; sample += 1) table[sample & 0xffff] = encode(sample);
  return table;
}

export const MULAW_DECODE: Int16Array = decodeTable(mulawDecodeRaw);
export const ALAW_DECODE: Int16Array = decodeTable(alawDecodeRaw);
const MULAW_ENCODE = encodeTable(mulawEncodeRaw);
const ALAW_ENCODE = encodeTable(alawEncodeRaw);

export const mulawDecodeSample = (code: number): number => MULAW_DECODE[code & 0xff]!;
export const mulawEncodeSample = (sample: number): number => MULAW_ENCODE[sample & 0xffff]!;
export const alawDecodeSample = (code: number): number => ALAW_DECODE[code & 0xff]!;
export const alawEncodeSample = (sample: number): number => ALAW_ENCODE[sample & 0xffff]!;

export function mulawToPcm16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = MULAW_DECODE[bytes[i]!]!;
  return out;
}

export function pcm16ToMulaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = MULAW_ENCODE[pcm[i]! & 0xffff]!;
  return out;
}

export function alawToPcm16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = ALAW_DECODE[bytes[i]!]!;
  return out;
}

export function pcm16ToAlaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = ALAW_ENCODE[pcm[i]! & 0xffff]!;
  return out;
}
