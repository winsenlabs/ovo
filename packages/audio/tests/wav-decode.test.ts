import { describe, expect, it } from 'vitest';
import {
  PolyphaseResampler,
  WavDecodeError,
  decodeWav,
  downmixToMono,
  resampleClip,
} from '../src/index.ts';

type Chunk = [id: string, body: Uint8Array];

const u16 = (value: number) => [value & 0xff, value >> 8];
const u32 = (value: number) => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  value >>> 24,
];
const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => [...value].map((c) => c.charCodeAt(0));

/** A `fmt ` body; `extensible` wraps the tag in WAVE_FORMAT_EXTENSIBLE. */
function fmt(
  tag: number,
  channels: number,
  rate: number,
  bits: number,
  over: { blockAlign?: number; byteRate?: number; extensible?: boolean } = {},
): Uint8Array {
  const blockAlign = over.blockAlign ?? (channels * bits) / 8;
  const head = [
    ...u16(over.extensible ? 0xfffe : tag),
    ...u16(channels),
    ...u32(rate),
    ...u32(over.byteRate ?? rate * blockAlign),
    ...u16(blockAlign),
    ...u16(bits),
  ];
  if (!over.extensible) return Uint8Array.from(head);
  const guidTail = [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
  return Uint8Array.from([...head, ...u16(22), ...u16(bits), ...u32(3), ...u16(tag), ...guidTail]);
}

/** A RIFF/WAVE file from chunks, padded to even sizes unless `omitLastPad`. */
function wav(chunks: Chunk[], over: { riffSize?: number; omitLastPad?: boolean } = {}) {
  const body: number[] = [...text('WAVE')];
  chunks.forEach(([id, data], index) => {
    body.push(...text(id), ...u32(data.byteLength), ...data);
    const last = index === chunks.length - 1;
    if (data.byteLength % 2 && !(last && over.omitLastPad)) body.push(0);
  });
  return Uint8Array.from([...text('RIFF'), ...u32(over.riffSize ?? body.length), ...body]);
}

const pcm16 = (...samples: number[]) => Uint8Array.from(samples.flatMap((s) => u16(s & 0xffff)));

function refused(file: Uint8Array): WavDecodeError {
  try {
    decodeWav(file);
  } catch (error) {
    if (error instanceof WavDecodeError) return error;
    throw error;
  }
  throw new Error('decodeWav accepted the file');
}

describe('decodeWav vectors', () => {
  it('decodes PCM16 little-endian mono exactly', () => {
    const decoded = decodeWav(
      wav([
        ['fmt ', fmt(1, 1, 16000, 16)],
        ['data', pcm16(0, 1, -1, 32767, -32768)],
      ]),
    );
    expect(decoded).toMatchObject({
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      frames: 5,
    });
    expect([...decoded.samples[0]!]).toEqual([0, 1, -1, 32767, -32768]);
  });

  it('decodes unsigned 8-bit PCM around 128', () => {
    const decoded = decodeWav(
      wav([
        ['fmt ', fmt(1, 1, 8000, 8)],
        ['data', bytes(0, 128, 255, 129)],
      ]),
    );
    expect(decoded.encoding).toBe('pcm_u8');
    expect([...decoded.samples[0]!]).toEqual([-32768, 0, 32512, 256]);
  });

  it('decodes μ-law and A-law through the G.711 tables', () => {
    const mulaw = decodeWav(
      wav([
        ['fmt ', fmt(7, 1, 8000, 8)],
        ['data', bytes(0xff, 0x00, 0x80, 0x7f)],
      ]),
    );
    expect(mulaw.encoding).toBe('mulaw');
    expect([...mulaw.samples[0]!]).toEqual([0, -32124, 32124, 0]);
    const alaw = decodeWav(
      wav([
        ['fmt ', fmt(6, 1, 8000, 8)],
        ['data', bytes(0xd5, 0x55)],
      ]),
    );
    expect(alaw.encoding).toBe('alaw');
    expect([...alaw.samples[0]!]).toEqual([8, -8]);
  });

  it('de-interleaves stereo and downmixes it to the channel average', () => {
    const decoded = decodeWav(
      wav([
        ['fmt ', fmt(1, 2, 44100, 16)],
        ['data', pcm16(1, 2, 3, 4, -100, 50)],
      ]),
    );
    expect(decoded.channels).toBe(2);
    expect(decoded.frames).toBe(3);
    expect([...decoded.samples[0]!]).toEqual([1, 3, -100]);
    expect([...decoded.samples[1]!]).toEqual([2, 4, 50]);
    expect([...downmixToMono(decoded)]).toEqual([1, 3, -25]);
    const mono = decodeWav(
      wav([
        ['fmt ', fmt(1, 1, 8000, 16)],
        ['data', pcm16(7)],
      ]),
    );
    expect(downmixToMono(mono)).toBe(mono.samples[0]);
  });

  it('reads WAVE_FORMAT_EXTENSIBLE PCM and μ-law', () => {
    const pcm = decodeWav(
      wav([
        ['fmt ', fmt(1, 2, 48000, 16, { extensible: true })],
        ['data', pcm16(5, 6)],
      ]),
    );
    expect(pcm).toMatchObject({ encoding: 'pcm_s16le', channels: 2, frames: 1 });
    const mulaw = decodeWav(
      wav([
        ['fmt ', fmt(7, 1, 8000, 8, { extensible: true })],
        ['data', bytes(0xff, 0xff)],
      ]),
    );
    expect(mulaw.encoding).toBe('mulaw');
  });

  it('skips LIST, fact and odd-sized chunks with their padding', () => {
    const decoded = decodeWav(
      wav([
        ['LIST', Uint8Array.from(text('INFOx'))],
        ['fmt ', fmt(1, 1, 8000, 16)],
        ['fact', bytes(1, 0, 0, 0)],
        ['junk', bytes(9)],
        ['data', pcm16(42, -42)],
        ['LIST', bytes(1, 2, 3)],
      ]),
    );
    expect([...decoded.samples[0]!]).toEqual([42, -42]);
  });

  it('accepts an odd final data chunk with its pad byte, or without it', () => {
    const chunks: Chunk[] = [
      ['fmt ', fmt(1, 1, 8000, 8)],
      ['data', bytes(128, 129, 130)],
    ];
    expect(decodeWav(wav(chunks)).frames).toBe(3);
    const omitted = wav(chunks, { omitLastPad: true });
    expect(decodeWav(omitted).frames).toBe(3);
    // The writer counted the pad byte it never wrote.
    const counted = wav(chunks, { omitLastPad: true, riffSize: omitted.byteLength - 7 });
    expect(decodeWav(counted).frames).toBe(3);
  });

  it('returns zero frames for an empty data chunk (the caller bounds duration)', () => {
    expect(
      decodeWav(
        wav([
          ['fmt ', fmt(1, 1, 8000, 16)],
          ['data', bytes()],
        ]),
      ).frames,
    ).toBe(0);
  });
});

describe('decodeWav refusals', () => {
  const fmt16 = (): Chunk => ['fmt ', fmt(1, 1, 8000, 16)];
  /** A valid one-sample file with this RIFF size, and `extra` bytes after it. */
  const one = (riffSize?: number, extra: number[] = []) =>
    Uint8Array.from([...wav([fmt16(), ['data', pcm16(1)]], { riffSize }), ...extra]);
  const withFmt = (format: Uint8Array, data = pcm16(1)) =>
    wav([
      ['fmt ', format],
      ['data', data],
    ]);
  const longData = () => {
    const file = wav([fmt16(), ['data', pcm16(1, 2)]]);
    file.set(u32(400), 40);
    return file;
  };

  const unsupportedFiles: [string, Uint8Array, RegExp][] = [
    ['not RIFF', Uint8Array.from(text('ID3\u0003 not a wav file')), /Not a RIFF/],
    ['too short', Uint8Array.from(text('RIFF')), /Not a RIFF/],
    [
      'RIFF but not WAVE',
      Uint8Array.from([...text('RIFF'), ...u32(4), ...text('AVI ')]),
      /Not a RIFF/,
    ],
    ['IEEE float', withFmt(fmt(3, 1, 8000, 32), bytes(0, 0, 0, 0)), /encoding 3\/32/],
    ['24-bit PCM', withFmt(fmt(1, 1, 8000, 24), bytes(0, 0, 0)), /encoding 1\/24/],
    ['MP3 in WAV', withFmt(fmt(0x55, 1, 8000, 0, { blockAlign: 1 }), bytes(0, 0)), /encoding 85/],
    ['three channels', withFmt(fmt(1, 3, 8000, 16), pcm16(0, 0, 0)), /3 channels/],
    ['96 kHz', withFmt(fmt(1, 1, 96000, 16)), /96000 Hz/],
    ['6 kHz', withFmt(fmt(1, 1, 6000, 16)), /6000 Hz/],
    [
      'extensible float',
      withFmt(fmt(3, 1, 8000, 32, { extensible: true }), bytes(0, 0, 0, 0)),
      /encoding 3/,
    ],
  ];
  it.each(unsupportedFiles)('refuses %s as unsupported', (_, file, message) => {
    const error = refused(file);
    expect(error.kind).toBe('unsupported');
    expect(error.message).toMatch(message);
  });

  const invalidFiles: [string, Uint8Array, RegExp][] = [
    [
      'a cut file',
      wav([fmt16(), ['data', pcm16(1, 2, 3, 4)]]).subarray(0, 50),
      /shorter than its RIFF/,
    ],
    ['a data chunk longer than the file', longData(), /Truncated data chunk/],
    ['a RIFF size past the end', one(400), /shorter than its RIFF/],
    ['bytes after the RIFF chunk', one(undefined, [0, 0]), /follow the end/],
    ['chunk sizes that do not add up', one(39), /do not add up/],
    ['a truncated chunk header', one(40, [1, 2]), /Truncated chunk header/],
    ['no chunks at all', wav([]), /No fmt chunk/],
    ['no data chunk', wav([fmt16()]), /No data chunk/],
    ['no fmt chunk', wav([['data', pcm16(1)]]), /before the fmt/],
    ['data before fmt', wav([['data', pcm16(1)], fmt16()]), /before the fmt/],
    ['two data chunks', wav([fmt16(), ['data', pcm16(1)], ['data', pcm16(2)]]), /one data/],
    ['two fmt chunks', wav([fmt16(), fmt16(), ['data', pcm16(1)]]), /one fmt/],
    ['a short fmt chunk', withFmt(fmt(1, 1, 8000, 16).subarray(0, 14)), /shorter than 16/],
    [
      'a short extension',
      withFmt(fmt(1, 1, 8000, 16, { extensible: true }).subarray(0, 30)),
      /22-byte/,
    ],
    ['a wrong block alignment', withFmt(fmt(1, 2, 8000, 16, { blockAlign: 2 })), /Block alignment/],
    ['a wrong byte rate', withFmt(fmt(1, 1, 8000, 16, { byteRate: 8000 })), /Byte rate/],
    ['16-bit μ-law', withFmt(fmt(7, 1, 8000, 16)), /8-bit, not 16/],
    ['a partial frame', withFmt(fmt(1, 2, 8000, 16), pcm16(1, 2, 3)), /whole number of frames/],
  ];
  it.each(invalidFiles)('refuses %s as invalid', (_, file, message) => {
    const error = refused(file);
    expect(error.kind).toBe('invalid');
    expect(error.message).toMatch(message);
  });
});

function tone(freq: number, rate: number, seconds: number, amplitude = 12000): Int16Array {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

const rms = (signal: Int16Array) =>
  Math.sqrt(signal.reduce((sum, s) => sum + s * s, 0) / Math.max(1, signal.length));

describe('resampleClip', () => {
  it.each([11025, 12000, 22050, 32000, 44100, 48000, 16000])(
    'brings %i Hz to 8 kHz aligned and at full length',
    (rate) => {
      const out = resampleClip(tone(440, rate, 1), rate, 8000);
      expect(out.length).toBe(8000);
      const ideal = tone(440, 8000, 1);
      const steady = out.subarray(400, 7600);
      expect(rms(steady) / rms(ideal.subarray(400, 7600))).toBeCloseTo(1, 2);
      // Aligned to within a sample: the ideal sine fits best at lag -1, 0 or 1, never further.
      const misfit = (lag: number) =>
        steady.reduce((sum, s, i) => sum + Math.abs(s - ideal[400 + i + lag]!), 0);
      const lags = [-3, -2, -1, 0, 1, 2, 3];
      const best = lags.reduce((a, b) => (misfit(b) < misfit(a) ? b : a));
      expect(Math.abs(best)).toBeLessThanOrEqual(1);
    },
  );

  it('removes content above the 8 kHz Nyquist instead of folding it into the band', () => {
    // 6 kHz at 44.1 kHz would alias to 2 kHz.
    const out = resampleClip(tone(6000, 44100, 1), 44100, 8000);
    expect(20 * Math.log10(rms(out.subarray(400, 7600)) / (12000 / Math.SQRT2))).toBeLessThan(-60);
  });

  it('copies a clip already at the target rate', () => {
    const input = tone(440, 8000, 0.1);
    const out = resampleClip(input, 8000, 8000);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('keeps live resamplers to the streaming rates', () => {
    expect(() => new PolyphaseResampler(44100, 8000)).toThrow(RangeError);
    expect(() => new PolyphaseResampler(44100, 8000, { anyRate: true })).not.toThrow();
    expect(() => new PolyphaseResampler(7000, 8000, { anyRate: true })).toThrow(RangeError);
    expect(() => new PolyphaseResampler(8000, 96000, { anyRate: true })).toThrow(RangeError);
  });
});
