import { describe, expect, it } from 'vitest';
import { mulawToPcm16, pcm16ToBytes, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import type { AudioFilter, AudioFormat, EndReason, MediaDuplex } from '@winsendotai/ovo-contracts';
import { filteredMedia, IngressFilter } from '../src/engine/ingress-filter.ts';

/** Halves every sample and records each call, so the wiring is visible. */
function halver() {
  const seen: number[][] = [];
  const filter: AudioFilter = {
    start: () => undefined,
    filter: (pcm) => {
      seen.push([...pcm]);
      return Int16Array.from(pcm, (v) => v >> 1);
    },
    stop: () => undefined,
  };
  return { filter, seen };
}

describe('IngressFilter', () => {
  it('filters μ-law carrier audio as PCM and re-encodes it', () => {
    const format: AudioFormat = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
    const { filter } = halver();
    const pcm = Int16Array.from([8000, -8000, 4000, 0]);
    const out = new IngressFilter(format, filter).apply(pcm16ToMulaw(pcm));
    expect([...mulawToPcm16(out)].map((v) => Math.round(v / 1000))).toEqual([4, -4, 2, 0]);
  });

  it('carries the odd byte of a PCM sample split across carrier frames', () => {
    const format: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 8000, channels: 1 };
    const { filter, seen } = halver();
    const ingress = new IngressFilter(format, filter);
    const bytes = pcm16ToBytes(Int16Array.from([1000, 2000, 3000]));
    const first = ingress.apply(bytes.subarray(0, 3));
    const second = ingress.apply(bytes.subarray(3));
    expect(seen).toEqual([[1000], [2000, 3000]]);
    expect([...first, ...second]).toEqual([...pcm16ToBytes(Int16Array.from([500, 1000, 1500]))]);
  });
});

/** A μ-law carrier whose audio, buffer level and close the test drives. */
function carrier() {
  const audio = new Set<(bytes: Uint8Array, tsMs: number) => void>();
  const closes = new Set<(reason: EndReason) => void>();
  const media = {
    sessionId: 's1',
    format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
    bufferedBytes: 0,
    onAudio: (fn: (bytes: Uint8Array, tsMs: number) => void) => {
      audio.add(fn);
      return () => audio.delete(fn);
    },
    onClose: (fn: (reason: EndReason) => void) => {
      closes.add(fn);
      return () => closes.delete(fn);
    },
  } as unknown as MediaDuplex & { bufferedBytes: number };
  const send = (pcm: number[]) => {
    for (const fn of audio) fn(pcm16ToMulaw(Int16Array.from(pcm)), 20);
  };
  const close = () => {
    for (const fn of closes) fn('completed' as EndReason);
  };
  return { media, audio, send, close };
}

describe('filteredMedia', () => {
  it('is the carrier itself without a filter', () => {
    const { media } = carrier();
    expect(filteredMedia(media)).toBe(media);
  });

  it('filters each carrier frame once for every listener and passes the rest through', () => {
    const { media, audio, send, close } = carrier();
    const { filter, seen } = halver();
    let stopped = 0;
    const filtered = filteredMedia(media, { ...filter, stop: () => void stopped++ });
    const heard: number[][] = [];
    const first = filtered.onAudio((bytes) => heard.push([...mulawToPcm16(bytes)]));
    const second = filtered.onAudio((bytes) => heard.push([...mulawToPcm16(bytes)]));
    send([8000]);
    expect(seen.length).toBe(1);
    expect(heard.map(([v]) => Math.round(v! / 1000))).toEqual([4, 4]);
    media.bufferedBytes = 640;
    expect(filtered.bufferedBytes).toBe(640);
    expect(filtered.sessionId).toBe('s1');
    first();
    second();
    expect(audio.size).toBe(0);
    close();
    expect(stopped).toBe(1);
  });
});
