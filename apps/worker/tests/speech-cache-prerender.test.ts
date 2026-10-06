import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import type { SpeechClipRef } from '@winsendotai/ovo-plugin-speech-cache/postgres';
import { createPrerenderMeter } from '../src/speech-cache-meter.ts';
import { warmReleaseClips } from '../src/speech-cache-prerender.ts';
import { WorkerSpeechClipCache, type SpeechClipStore } from '../src/speech-cache-tiers.ts';
import { composeCacheOutput, fixtureRelease, RecordingTts } from './speech-cache-harness.ts';

const options = { concurrency: 2, attempts: 3, renderTimeoutMs: 5_000, backoffMs: 0 };
const silent = createLogger({}, { sink: () => undefined });

function store() {
  const clips = new Map<string, Uint8Array>();
  const refs: SpeechClipRef[] = [];
  const value: SpeechClipStore = {
    maxClipBytes: 1 << 20,
    get: async (_workspace, key) => clips.get(key),
    getMany: async (_workspace, keys) =>
      new Map(keys.filter((key) => clips.has(key)).map((key) => [key, clips.get(key)!])),
    put: async (clip) => {
      clips.set(clip.key, clip.audio);
      return 'stored';
    },
    markRefs: async (_workspace, _release, next) => {
      refs.push(...next);
    },
  };
  return { value, clips, refs };
}

const release = fixtureRelease({
  speechCache: { enabled: true },
  message: 'Hello, this is Monika from the bank.',
  clarification: 'Could you say that again?',
  uncertainty: 'I do not have that information.',
  processing: { initial: 'One moment.', failure: 'That did not work.' },
  faq: [
    { id: 'hours', question: 'hours?', answer: 'We are open nine to six.' },
    { id: 'due', question: 'due?', answer: 'Your EMI of {{emi}} is due.' },
  ],
});

describe('speech clip pre-render (TTS-9)', () => {
  it('renders every fixed line once, then only what is missing', async () => {
    const tts = new RecordingTts();
    const durable = store();
    const cache = new WorkerSpeechClipCache();
    const signal = new AbortController().signal;
    const first = await warmReleaseClips(
      { release, tts, filters: [], onUsage: () => undefined, signal },
      { cache, store: durable.value, options },
    );
    expect(first).toMatchObject({ state: 'done', total: 6, rendered: 6, existing: 0, perCall: 1 });
    expect(tts.calls.map((call) => call.text)).not.toContain('Your EMI of {{emi}} is due.');
    expect(durable.clips.size).toBe(6);
    expect(cache.pinned.stats.entries).toBe(6);
    // Another worker: empty memory, shared durable tier, nothing left to render.
    const second = await warmReleaseClips(
      { release, tts, filters: [], onUsage: () => undefined, signal },
      { cache: new WorkerSpeechClipCache(), store: durable.value, options },
    );
    expect(second).toMatchObject({ state: 'done', existing: 6, rendered: 0 });
    expect(tts.calls).toHaveLength(6);
    expect(durable.refs.filter((ref) => ref.status === 'ready')).toHaveLength(12);
  });

  it('pre-rendered clips are hits for the live call, with no live synthesis', async () => {
    const tts = new RecordingTts();
    const cache = new WorkerSpeechClipCache();
    await warmReleaseClips(
      { release, tts, filters: [], onUsage: () => undefined, signal: new AbortController().signal },
      { cache, options },
    );
    const live = new RecordingTts();
    const session = await composeCacheOutput({ release, cache, tts: live });
    await session.play('Hello, this is Monika from the bank.', 'response');
    await session.play('We are open nine to six.', 'response');
    await session.dispose();
    expect(live.calls).toEqual([]);
  });

  it('retries a failing line, then records what still failed', async () => {
    const tts = new RecordingTts();
    tts.failures = 2;
    const durable = store();
    const result = await warmReleaseClips(
      { release, tts, filters: [], onUsage: () => undefined, signal: new AbortController().signal },
      {
        cache: new WorkerSpeechClipCache(),
        store: durable.value,
        options: { ...options, concurrency: 1 },
      },
    );
    expect(result).toMatchObject({ state: 'done', rendered: 6, failed: 0 });
    const broken = new RecordingTts();
    broken.failures = 100;
    const failed = await warmReleaseClips(
      {
        release: {
          ...release,
          id: 'release-broken',
          selections: { tts: { ...release.selections!.tts!, version: '2.0.0' } },
        },
        tts: broken,
        filters: [],
        onUsage: () => undefined,
        signal: new AbortController().signal,
      },
      { cache: new WorkerSpeechClipCache(), store: durable.value, options },
    );
    expect(failed).toMatchObject({ state: 'failed', failed: 6, rendered: 0 });
    expect(durable.refs.filter((ref) => ref.status === 'failed')).toHaveLength(6);
    expect(durable.refs.find((ref) => ref.status === 'failed')?.error).toContain(
      'provider unavailable',
    );
  });

  it('skips a release whose voice settings are not pinned in the release', async () => {
    const result = await warmReleaseClips(
      {
        release: { ...release, selections: {} },
        tts: new RecordingTts(),
        filters: [],
        onUsage: () => undefined,
        signal: new AbortController().signal,
      },
      { cache: new WorkerSpeechClipCache(), options },
    );
    expect(result).toMatchObject({ state: 'skipped', detail: 'tts binding is not pinned' });
  });

  it('never runs more renders at once than the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const tts = new RecordingTts();
    const synthesize = tts.synthesize.bind(tts);
    tts.synthesize = async function* (input) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        yield* synthesize(input);
      } finally {
        inFlight -= 1;
      }
    };
    await warmReleaseClips(
      { release, tts, filters: [], onUsage: () => undefined, signal: new AbortController().signal },
      { cache: new WorkerSpeechClipCache(), options },
    );
    expect(peak).toBe(2);
  });

  it('meters pre-render synthesis to the workspace as its own usage kind', async () => {
    const recordUsage = vi.fn(async () => ({}) as never);
    const priced = fixtureRelease({
      ...release.config,
      costPolicy: {
        budgetId: 'budget-1',
        reservationPaise: '100',
        maxCallSeconds: 60,
        priceCards: { 'fixture.streaming-tts.characters': { id: 'card', version: '1' } },
      },
    });
    const meter = createPrerenderMeter(priced, { recordUsage }, silent);
    const tts = new RecordingTts();
    await warmReleaseClips(
      {
        release: priced,
        tts,
        filters: [],
        onUsage: meter.sink,
        signal: new AbortController().signal,
      },
      { cache: new WorkerSpeechClipCache(), options },
    );
    expect(await meter.flush()).toEqual({ recorded: 6, unpriced: [], failed: 0 });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-a',
        sessionId: 'prerender:release-1',
        sourceKind: 'tts-generation',
        sourceEventType: 'speech.prerender',
        activity: 'startup',
        cacheDisposition: 'generation',
        unit: 'characters',
        priceCard: { id: 'card', version: '1' },
      }),
    );
    const unpriced = createPrerenderMeter(release, { recordUsage }, silent);
    unpriced.sink(tts.meters[0]!);
    expect(await unpriced.flush()).toEqual({
      recorded: 0,
      unpriced: ['fixture.streaming-tts.characters'],
      failed: 0,
    });
  });
});
