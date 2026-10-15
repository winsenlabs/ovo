import { createHash } from 'node:crypto';
import { MULAW_8K, type TextToSpeech } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { describe, expect, it, vi } from 'vitest';
import { HoldClipCache } from '../src/hold-clips.ts';
import { createHoldVoice } from '../src/hold-voice.ts';
import { WorkerSpeechClipCache } from '../src/speech-cache-tiers.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clip = (byte: number, size = 100) => new Uint8Array(size).fill(byte);

describe('HoldClipCache (transfer design 7.6)', () => {
  it('reads a clip once by its pinned digest and shares concurrent reads', async () => {
    const bytes = clip(1);
    const load = vi.fn(async () => bytes);
    const cache = new HoldClipCache(load);
    const [first, second] = await Promise.all([
      cache.get('clip-1', digest(bytes)),
      cache.get('clip-1', digest(bytes)),
    ]);
    expect(first).toBe(bytes);
    expect(second).toBe(bytes);
    expect(await cache.get('clip-1', digest(bytes))).toBe(bytes);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith('clip-1', digest(bytes));
  });

  it('treats bytes that do not hash to the pinned digest, or no digest, as missing', async () => {
    const cache = new HoldClipCache(async () => clip(2));
    expect(await cache.get('clip-1', 'b'.repeat(64))).toBeUndefined();
    expect(await cache.get('clip-1', undefined)).toBeUndefined();
    expect(cache.size).toEqual({ clips: 0, bytes: 0 });
  });

  it('evicts the least recently played clips past its byte bound', async () => {
    const clips = new Map([1, 2, 3].map((byte) => [`c${byte}`, clip(byte)]));
    const cache = new HoldClipCache(async (id) => clips.get(id), 250);
    for (const id of ['c1', 'c2']) await cache.get(id, digest(clips.get(id)!));
    await cache.get('c1', digest(clips.get('c1')!));
    await cache.get('c3', digest(clips.get('c3')!));
    expect(cache.size).toEqual({ clips: 2, bytes: 200 });
    const load = vi.fn(async (id: string) => clips.get(id));
    const reread = new HoldClipCache(load, 250);
    for (const id of ['c1', 'c2', 'c1', 'c3', 'c1', 'c2'])
      await reread.get(id, digest(clips.get(id)!));
    // c2 was the least recently played when c3 arrived: only it is read again.
    expect(load.mock.calls.map(([id]) => id)).toEqual(['c1', 'c2', 'c3', 'c2']);
  });
});

describe('the house voice for hold lines (transfer design 7.6)', () => {
  const release = {
    id: 'release-router',
    agentId: 'front',
    workspaceId: 'workspace-1',
    config: { language: 'en' },
    providerBindings: {},
    selections: {
      tts: { pluginId: 'fixture-tts', version: '1.0.0', config: { voice: 'asha' } },
    },
  } as unknown as ReleaseRecord;

  function voice(synthesize: (text: string) => AsyncIterable<Uint8Array>) {
    const tiers = new WorkerSpeechClipCache(
      {},
      { pinnedMaxBytes: 1_000_000, maxClipBytes: 100_000 },
    );
    const tts = {
      capabilities: { outputFormats: [MULAW_8K] },
      cacheIdentity: () => ({ provider: 'fixture', model: 'm', voice: 'asha', revision: '1' }),
      synthesize: vi.fn((input: { text: string }) => synthesize(input.text)),
    } as unknown as TextToSpeech & { synthesize: ReturnType<typeof vi.fn> };
    const open = vi.fn(async () => ({ tts, filters: [], close: vi.fn(async () => undefined) }));
    const usage = vi.fn();
    const house = createHoldVoice({
      ...{ release, format: MULAW_8K, sessionId: 'session-1', open, usage, tiers },
      renderTimeoutMs: 50,
    });
    return { house, tts, open, tiers };
  }

  it('renders a line once on a miss, keeps it, and plays it from the cache after', async () => {
    const h = voice(async function* (text) {
      yield new TextEncoder().encode(text);
    });
    const signal = new AbortController().signal;
    const first = await h.house.render('Thank you for holding.', 'en', signal);
    expect(new TextDecoder().decode(first)).toBe('Thank you for holding.');
    const again = await h.house.render('Thank you for holding.', 'en', signal);
    expect(again).toEqual(first);
    expect(h.tts.synthesize).toHaveBeenCalledOnce();
    expect(h.open).toHaveBeenCalledOnce();
    await h.house.close();
  });

  it('gives up on a render past its bound', async () => {
    const h = voice(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 500));
      yield new Uint8Array(1);
    });
    await expect(h.house.render('Hold on.', 'en', new AbortController().signal)).rejects.toThrow();
  });
});
