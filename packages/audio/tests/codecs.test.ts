import { describe, expect, it } from 'vitest';
import {
  MULAW_8K,
  PCM16_16K,
  PCM16_24K,
  PCM16_8K,
  type AudioFormat,
} from '@winsendotai/ovo-contracts';
import {
  ALAW_DECODE,
  FrameAggregator,
  MULAW_DECODE,
  alawEncodeSample,
  bytesToPcm16,
  createTranscoder,
  firstReachable,
  mulawDecodeSample,
  mulawEncodeSample,
  mulawToPcm16,
  pcm16ToBytes,
  plan,
  reachable,
  reachableFormats,
  silence,
} from '../src/index.ts';

describe('G.711', () => {
  it('round-trips all 256 μ-law codes (0x7F is negative zero and canonicalises to 0xFF)', () => {
    for (let code = 0; code < 256; code += 1) {
      const value = mulawDecodeSample(code);
      const reencoded = mulawEncodeSample(value);
      expect(reencoded).toBe(code === 0x7f ? 0xff : code);
      expect(mulawDecodeSample(reencoded)).toBe(value);
    }
    expect(MULAW_DECODE[0x7f]).toBe(0);
    expect(MULAW_DECODE[0x00]).toBe(-32124);
    expect(MULAW_DECODE[0x80]).toBe(32124);
  });

  it('round-trips all 256 A-law codes', () => {
    for (let code = 0; code < 256; code += 1)
      expect(alawEncodeSample(ALAW_DECODE[code]!)).toBe(code);
    expect(ALAW_DECODE[0xd5]).toBe(8);
    expect(ALAW_DECODE[0x55]).toBe(-8);
  });

  it('keeps μ-law quantisation error within one step', () => {
    for (let sample = -32000; sample <= 32000; sample += 97) {
      const decoded = mulawDecodeSample(mulawEncodeSample(sample));
      expect(Math.abs(decoded - sample)).toBeLessThanOrEqual(Math.max(8, Math.abs(sample) / 16));
    }
  });

  it('converts PCM16 little-endian bytes exactly', () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    const bytes = pcm16ToBytes(pcm);
    expect([...bytes.subarray(0, 6)]).toEqual([0, 0, 1, 0, 0xff, 0xff]);
    expect(bytesToPcm16(bytes)).toEqual(pcm);
    expect(() => bytesToPcm16(new Uint8Array(3))).toThrow(RangeError);
  });
});

describe('codec graph', () => {
  it('plans μ-law 8k → PCM16 16k as decode then resample', () => {
    const result = plan(MULAW_8K, PCM16_16K);
    expect(result?.steps).toEqual([
      { kind: 'decode', from: 'mulaw' },
      { kind: 'resample', from: 8000, to: 16000 },
    ]);
  });

  it('plans PCM16 24k → μ-law 8k as resample then encode', () => {
    expect(plan(PCM16_24K, MULAW_8K)?.steps).toEqual([
      { kind: 'resample', from: 24000, to: 8000 },
      { kind: 'encode', to: 'mulaw' },
    ]);
    expect(plan(MULAW_8K, MULAW_8K)?.steps).toEqual([]);
  });

  it('rejects impossible targets', () => {
    const cd: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 };
    const stereo = { ...PCM16_8K, channels: 2 } as unknown as AudioFormat;
    expect(plan(MULAW_8K, cd)).toBeUndefined();
    expect(plan(MULAW_8K, stereo)).toBeUndefined();
    expect(reachable(MULAW_8K, [cd, PCM16_16K])).toEqual([PCM16_16K]);
    expect(firstReachable(MULAW_8K, [cd])).toBeUndefined();
    expect(firstReachable(PCM16_8K, [PCM16_16K, PCM16_8K])).toEqual(PCM16_8K);
    // PCM16 at the four resampler rates, plus μ-law and A-law at 8 kHz only.
    expect(reachableFormats(MULAW_8K)).toEqual([
      MULAW_8K,
      { encoding: 'alaw', sampleRate: 8000, channels: 1 },
      PCM16_8K,
      PCM16_16K,
      { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 },
      { encoding: 'pcm_s16le', sampleRate: 48000, channels: 1 },
    ]);
  });

  it('refuses G.711 at any rate but 8 kHz', () => {
    const mulaw48: AudioFormat = { encoding: 'mulaw', sampleRate: 48000, channels: 1 };
    const alaw16: AudioFormat = { encoding: 'alaw', sampleRate: 16000, channels: 1 };
    expect(plan(PCM16_8K, mulaw48)).toBeUndefined();
    expect(plan(alaw16, PCM16_8K)).toBeUndefined();
    expect(
      reachableFormats(PCM16_24K).some((f) => f.encoding !== 'pcm_s16le' && f.sampleRate !== 8000),
    ).toBe(false);
  });

  it('never hands an identity transcode the caller its own buffer back', () => {
    const transcoder = createTranscoder(plan(MULAW_8K, MULAW_8K)!, { now: () => 0 });
    const input = new Uint8Array([1, 2, 3, 4]);
    const output = transcoder.push(input);
    expect(Array.from(output)).toEqual([1, 2, 3, 4]);
    input[0] = 99;
    expect(output[0]).toBe(1);
  });

  it('transcodes μ-law 8k to PCM16 16k statefully', () => {
    const transcoder = createTranscoder(plan(MULAW_8K, PCM16_16K)!, { now: () => 0 });
    const input = new Uint8Array(800).map((_, i) => (i * 37) & 0xff);
    const output = new Uint8Array([
      ...transcoder.push(input.subarray(0, 333)),
      ...transcoder.push(input.subarray(333)),
      ...transcoder.flush(),
    ]);
    expect(output.length % 2).toBe(0);
    expect(output.length / 2).toBeGreaterThanOrEqual(1600);
    expect(mulawToPcm16(input).length).toBe(800);
  });
});

describe('FrameAggregator and silence', () => {
  it('emits whole frames and flushes a padded remainder', () => {
    const frames = new FrameAggregator(PCM16_16K, 20);
    expect(frames.frameBytes).toBe(640);
    expect(frames.push(new Uint8Array(1000))).toHaveLength(1);
    expect(frames.push(new Uint8Array(301))).toHaveLength(1);
    expect(frames.pendingBytes).toBe(21);
    const rest = frames.flush({ padToMs: 20 });
    expect(rest?.byteLength).toBe(640);
    expect(frames.flush()).toBeUndefined();
  });

  it('encodes silence per encoding', () => {
    expect([...silence(MULAW_8K, 1)]).toEqual(new Array(8).fill(0xff));
    expect(silence(PCM16_8K, 10).byteLength).toBe(160);
  });
});
