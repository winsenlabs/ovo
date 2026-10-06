import { describe, expect, it, vi } from 'vitest';
import { BoundedByteCache } from '@winsendotai/ovo-plugin-cache';
import { markdownFilter } from '../../../packages/plugin-voice/src/speech/text-filters.ts';
import { indianVerbalisationFilter } from '../../../packages/plugin-voice/src/speech/indian-verbalisation.ts';
import { WorkerSpeechCacheRuntime } from '../src/speech-cache-runtime.ts';
import type { SpeechClipStore } from '../src/speech-cache-tiers.ts';
import {
  composeCacheOutput,
  deferred,
  fixtureRelease,
  RecordingTts,
} from './speech-cache-harness.ts';

function memoryStore(seed: Record<string, Uint8Array> = {}) {
  const clips = new Map(Object.entries(seed));
  const puts: string[] = [];
  const store: SpeechClipStore = {
    maxClipBytes: 1 << 20,
    get: async (_workspace, key) => clips.get(key),
    getMany: async (_workspace, keys) =>
      new Map(keys.filter((key) => clips.has(key)).map((key) => [key, clips.get(key)!])),
    put: async (clip) => {
      puts.push(clip.key);
      clips.set(clip.key, clip.audio);
      return 'stored';
    },
    markRefs: async () => undefined,
  };
  return { store, clips, puts };
}

describe('worker speech cache output', () => {
  it('drives an incremental provider through open() for live and cache-miss speech (TTS-4)', async () => {
    const tts = new RecordingTts(true);
    const runtime = new WorkerSpeechCacheRuntime();
    const session = await composeCacheOutput({
      release: fixtureRelease({ speechCache: { enabled: true }, uncertainty: 'I am not sure.' }),
      cache: runtime.cache,
      tts,
    });
    try {
      await session.play('A dynamic model answer.');
      await session.play('I am not sure.');
      expect(tts.calls.map((call) => call.path)).toEqual(['open', 'open']);
      expect(session.marks).toEqual(['s1:1', 's2:2:cache']);
    } finally {
      await session.dispose();
      await runtime.close();
    }
  });

  it('caches every fixed line whatever its speech kind, on post-filter text (TTS-5/6)', async () => {
    const tts = new RecordingTts();
    const runtime = new WorkerSpeechCacheRuntime();
    const release = fixtureRelease({
      speechCache: { enabled: true },
      language: 'en-IN',
      uncertainty: 'Your EMI of **₹4,850** is due.',
      decision: {
        enabled: true,
        state: { sources: ['last-turn'] },
        questions: [
          {
            id: 'intent',
            type: 'noul',
            instructions: 'Will they pay?',
            threshold: 0.6,
            fallback: 'llm',
            yes: { description: 'Yes', outcome: { say: 'Thank you, that helps.' } },
            no: { description: 'No', outcome: {} },
          },
        ],
      },
    });
    const filters = [markdownFilter, indianVerbalisationFilter];
    const spoken = 'Your EMI of four thousand eight hundred and fifty rupees is due.';
    for (let call = 0; call < 2; call += 1) {
      const session = await composeCacheOutput({ release, cache: runtime.cache, tts, filters });
      try {
        await session.play(spoken, 'response');
        await session.play('Thank you, that helps.', 'response');
        await session.play('An answer the model wrote.', 'response');
      } finally {
        await session.dispose();
      }
    }
    expect(tts.calls.map((call) => call.text)).toEqual([
      spoken,
      'Thank you, that helps.',
      'An answer the model wrote.',
      'An answer the model wrote.',
    ]);
    await runtime.close();
  });

  it('looks up pinned, then L1, then durable before rendering live (TTS-7/8)', async () => {
    const tts = new RecordingTts();
    const runtime = new WorkerSpeechCacheRuntime();
    const durable = memoryStore();
    runtime.cache.attachDurable(durable.store);
    const audits: { kind: string; payload: Record<string, unknown> }[] = [];
    const observer = {
      audit: (kind: string, payload: Record<string, unknown>) => audits.push({ kind, payload }),
    };
    const release = fixtureRelease({ speechCache: { enabled: true }, clarification: 'Sorry?' });
    const first = await composeCacheOutput({ release, cache: runtime.cache, tts, observer });
    await first.play('Sorry?');
    await first.play('Sorry?');
    await first.dispose();
    await vi.waitFor(() => expect(durable.puts).toHaveLength(1));
    // A restarted worker has empty memory: the clip comes back from the durable tier.
    const restarted = new WorkerSpeechCacheRuntime();
    restarted.cache.attachDurable(durable.store);
    const second = await composeCacheOutput({ release, cache: restarted.cache, tts, observer });
    await second.play('Sorry?');
    await second.play('Sorry?');
    await second.dispose();
    expect(tts.calls).toHaveLength(1);
    const sources = audits.filter((a) => a.kind === 'speech.cache').map((a) => a.payload.source);
    expect(sources).toEqual(['miss', 'pinned', 'durable', 'pinned']);
    const summaries = audits.filter((a) => a.kind === 'speech.cache.summary');
    expect(summaries.map((a) => a.payload)).toEqual([
      expect.objectContaining({ segments: 2, hitRate: 0.5 }),
      expect.objectContaining({ segments: 2, hitRate: 1 }),
    ]);
    for (const { payload } of audits) expect(JSON.stringify(payload)).not.toContain('Sorry');
    expect(audits[0]!.payload).toMatchObject({ bytes: 320, outcome: 'completed' });
    expect(typeof audits[0]!.payload.msToFirstByte).toBe('number');
    await runtime.close();
    await restarted.close();
  });

  it('never persists or pins model output, templated lines or an unpinned identity (TTS-8)', async () => {
    const tts = new RecordingTts();
    const runtime = new WorkerSpeechCacheRuntime();
    const durable = memoryStore();
    runtime.cache.attachDurable(durable.store);
    const release = fixtureRelease({
      speechCache: { enabled: true, announcement: true },
      mode: 'announcement',
      message: 'Hello {{customer.name}}.',
      variables: {
        type: 'object',
        properties: { customer: { type: 'object', properties: { name: { type: 'string' } } } },
      },
      processing: { initial: 'One moment.' },
    });
    const session = await composeCacheOutput({ release, cache: runtime.cache, tts });
    await session.play('Hello Asha.', 'response');
    await session.play('Your balance is 120.', 'response');
    await session.dispose();
    const unpinned = { ...release, selections: {}, id: 'release-2' };
    const legacy = await composeCacheOutput({ release: unpinned, cache: runtime.cache, tts });
    await legacy.play('One moment.', 'acknowledgment');
    await legacy.dispose();
    expect(durable.puts).toEqual([]);
    expect(runtime.cache.pinned.stats.entries).toBe(0);
    await runtime.close();
  });

  it('keeps a first render that the caller barged into, so the next caller hits (critic)', async () => {
    const tts = new RecordingTts();
    const gate = deferred();
    tts.gate = gate.promise;
    const runtime = new WorkerSpeechCacheRuntime();
    const release = fixtureRelease({ speechCache: { enabled: true }, clarification: 'Sorry?' });
    const first = await composeCacheOutput({ release, cache: runtime.cache, tts });
    const bargeIn = new AbortController();
    const interrupted = first.play('Sorry?', 'response', bargeIn.signal);
    await vi.waitFor(() => expect(first.audio.length).toBeGreaterThan(0));
    bargeIn.abort(new DOMException('caller spoke', 'AbortError'));
    expect(await interrupted).toMatchObject({ state: 'interrupted' });
    gate.resolve();
    await vi.waitFor(() => expect(runtime.cache.pinned.stats.entries).toBe(1));
    await first.dispose();
    tts.gate = undefined;
    const next = await composeCacheOutput({ release, cache: runtime.cache, tts });
    await next.play('Sorry?');
    await next.dispose();
    expect(tts.calls).toHaveLength(1);
    await runtime.close();
  });

  it('still serves a plain process ByteCache from L1', async () => {
    const tts = new RecordingTts();
    const cache = new BoundedByteCache();
    const release = fixtureRelease({ speechCache: { enabled: true }, clarification: 'Sorry?' });
    const session = await composeCacheOutput({ release, cache, tts });
    await session.play('Sorry?');
    await session.play('Sorry?');
    await session.dispose();
    expect(tts.calls).toHaveLength(1);
  });
});
