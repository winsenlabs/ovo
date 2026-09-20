import { describe, expect, it } from 'vitest';
import { BoundedByteCache } from '@winsendotai/ovo-plugin-cache';
import {
  BoundedSpeechScheduler,
  type SpeechOutputResult,
  type SpeechSegment,
} from '@winsendotai/ovo-plugin-voice';
import {
  CachedSpeechOutput,
  createSpeechCacheKey,
  createSpeechCacheOutputPlugin,
  type AudioPlayer,
  type NormalizedTts,
  type SpeechCacheOutputConfig,
  type SpeechCacheTelemetry,
} from '../src/index.ts';

const baseConfig: SpeechCacheOutputConfig = {
  workspaceId: 'workspace-a',
  provider: 'simulated-tts',
  bindingVersion: 'binding-v1',
  model: 'fixture-model',
  voice: 'fixture-voice',
  locale: 'en-IN',
  codec: 'pcm16',
  sampleRate: 8_000,
  pronunciation: 'pronunciation-v1',
  prosodyRevision: 'prosody-v1',
  optionsRevision: 'options-v1',
  approvedPhrases: [{ text: 'Please wait.', purpose: 'static-phrase' }],
};

class FixtureTts implements NormalizedTts {
  calls = 0;
  requests: Parameters<NormalizedTts['synthesize']>[0][] = [];

  async synthesize(request: Parameters<NormalizedTts['synthesize']>[0]) {
    this.calls += 1;
    this.requests.push(structuredClone(request));
    return {
      audio: Uint8Array.of(10, request.text.length, this.calls),
      usage: {
        provider: 'simulated-tts',
        requestId: `fixture-generation-${this.calls}`,
        quantity: String(request.text.length),
        unit: 'characters',
        state: 'reconciled' as const,
      },
    };
  }
}

class FixturePlayer implements AudioPlayer {
  played: number[][] = [];
  formats: { codec: string; sampleRate: number }[] = [];

  async play(request: Parameters<AudioPlayer['play']>[0]) {
    this.played.push([...request.audio]);
    this.formats.push({ codec: request.codec, sampleRate: request.sampleRate });
    request.audio[0] = 255; // proves playback cannot mutate cached bytes
    return {
      state: 'completed' as const,
      evidence: 'simulated' as const,
      usage: [
        {
          source: 'carrier' as const,
          provider: 'simulated-carrier',
          requestId: `fixture-playback-${this.played.length}`,
          quantity: '1',
          unit: 'media-segments',
          state: 'estimated' as const,
        },
      ],
    };
  }

  async interrupt(): Promise<void> {}
}

function segment(text: string, kind: SpeechSegment['kind'] = 'acknowledgment'): SpeechSegment {
  return { id: `segment-${Math.random()}`, text, kind, epoch: 0, generatedAt: 1 };
}

function output(
  config: SpeechCacheOutputConfig,
  cache: BoundedByteCache,
  tts: FixtureTts,
  player: FixturePlayer,
  events: SpeechCacheTelemetry[] = [],
) {
  return new CachedSpeechOutput(config, {
    cache,
    tts,
    player,
    emit: (event) => events.push(event),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('CachedSpeechOutput', () => {
  it('plays real cached bytes through BoundedSpeechScheduler on every hit', async () => {
    const cache = new BoundedByteCache();
    const tts = new FixtureTts();
    const player = new FixturePlayer();
    const events: SpeechCacheTelemetry[] = [];
    const scheduler = new BoundedSpeechScheduler(output(baseConfig, cache, tts, player, events));

    await scheduler.speak('Please wait.', { kind: 'acknowledgment' });
    await scheduler.speak('Please wait.', { kind: 'acknowledgment' });

    expect(tts.calls).toBe(1);
    expect(player.played).toEqual([
      [10, 12, 1],
      [10, 12, 1],
    ]);
    expect(events.filter((event) => event.type === 'cache').map((event) => event.outcome)).toEqual([
      'miss',
      'hit',
    ]);
    expect(
      events.filter((event) => event.type === 'usage' && event.phase === 'generation'),
    ).toHaveLength(1);
    const playback = events.filter(
      (event): event is Extract<SpeechCacheTelemetry, { type: 'usage' }> =>
        event.type === 'usage' && event.phase === 'playback',
    );
    expect(playback).toHaveLength(2);
    expect(playback.map((event) => event.usage.quantity)).toEqual(['1', '1']);
    await scheduler.dispose();
  });

  it('misses when workspace, voice, binding, or options revision changes', async () => {
    const cache = new BoundedByteCache();
    const tts = new FixtureTts();
    const player = new FixturePlayer();
    for (const changed of [
      { workspaceId: 'workspace-b' },
      { voice: 'fixture-voice-2' },
      { bindingVersion: 'binding-v2' },
      { optionsRevision: 'options-v2' },
    ])
      await output({ ...baseConfig, ...changed }, cache, tts, player).play(
        segment('Please wait.'),
        {
          signal: new AbortController().signal,
        },
      );
    expect(tts.calls).toBe(4);
  });

  it('bypasses dynamic, private, model-response, and substring matches by default', async () => {
    const cache = new BoundedByteCache();
    const tts = new FixtureTts();
    const player = new FixturePlayer();
    const events: SpeechCacheTelemetry[] = [];
    const adapter = output(baseConfig, cache, tts, player, events);
    const signal = new AbortController().signal;

    await adapter.play(segment('Please wait.', 'response'), { signal });
    await adapter.play(segment('Please wait for account 123.', 'acknowledgment'), { signal });
    await adapter.play(segment('Please wait.', 'acknowledgment'), { signal });
    await adapter.play(segment('Please wait.', 'acknowledgment'), { signal });

    expect(tts.calls).toBe(3);
    expect(events.filter((event) => event.type === 'cache').map((event) => event.outcome)).toEqual([
      'bypass',
      'bypass',
      'miss',
      'hit',
    ]);
  });

  it('coalesces synthesis while one canceled waiter leaves the other playback intact', async () => {
    const cache = new BoundedByteCache();
    const generated = deferred<Awaited<ReturnType<NormalizedTts['synthesize']>>>();
    let syntheses = 0;
    let producerAborted = false;
    const tts: NormalizedTts = {
      synthesize: (_request, { signal }) => {
        syntheses += 1;
        signal.addEventListener('abort', () => (producerAborted = true), { once: true });
        return generated.promise;
      },
    };
    const player = new FixturePlayer();
    const events: SpeechCacheTelemetry[] = [];
    const adapter = new CachedSpeechOutput(baseConfig, {
      cache,
      tts,
      player,
      emit: (event) => events.push(event),
    });
    const canceled = new AbortController();
    const first = adapter.play(segment('Please wait.'), { signal: canceled.signal });
    const second = adapter.play(segment('Please wait.'), { signal: new AbortController().signal });
    canceled.abort();
    generated.resolve({
      audio: Uint8Array.of(4, 5, 6),
      usage: {
        provider: 'simulated-tts',
        requestId: 'coalesced-generation',
        quantity: '12',
        unit: 'characters',
        state: 'reconciled',
      },
    });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const completed: SpeechOutputResult = {
      state: 'completed',
      evidence: 'simulated',
    };
    await expect(second).resolves.toEqual(completed);
    expect(syntheses).toBe(1);
    expect(producerAborted).toBe(false);
    expect(player.played).toEqual([[4, 5, 6]]);
    expect(events.filter((event) => event.type === 'cache').map((event) => event.outcome)).toEqual([
      'miss',
      'coalesced',
    ]);
  });

  it('isolates key, synthesis, and playback settings from later caller config mutation', async () => {
    const config = structuredClone(baseConfig);
    const cache = new BoundedByteCache();
    const tts = new FixtureTts();
    const player = new FixturePlayer();
    const adapter = output(config, cache, tts, player);
    const signal = new AbortController().signal;

    await adapter.play(segment('Please wait.'), { signal });
    config.workspaceId = 'mutated-workspace';
    config.voice = 'mutated-voice';
    config.codec = 'mutated-codec';
    config.sampleRate = 48_000;
    config.optionsRevision = 'mutated-options';
    config.approvedPhrases![0]!.text = 'Mutated phrase';
    await adapter.play(segment('Please wait.'), { signal });

    expect(tts.calls).toBe(1);
    expect(tts.requests[0]).toMatchObject({
      workspaceId: 'workspace-a',
      voice: 'fixture-voice',
      codec: 'pcm16',
      sampleRate: 8_000,
      optionsRevision: 'options-v1',
    });
    expect(player.formats).toEqual([
      { codec: 'pcm16', sampleRate: 8_000 },
      { codec: 'pcm16', sampleRate: 8_000 },
    ]);
  });

  it('rejects a pre-aborted play before cache lookup, synthesis, telemetry, or playback', async () => {
    const cache = new BoundedByteCache();
    const tts = new FixtureTts();
    const player = new FixturePlayer();
    const events: SpeechCacheTelemetry[] = [];
    const adapter = output(baseConfig, cache, tts, player, events);
    const aborted = new AbortController();
    aborted.abort(new DOMException('already canceled', 'AbortError'));

    await expect(
      adapter.play(segment('Please wait.'), { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.stats).toEqual({ entries: 0, bytes: 0, pending: 0 });
    expect(tts.calls).toBe(0);
    expect(player.played).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('uses opaque complete keys and declares only normalized plugin ports', () => {
    const text = 'private fixture text';
    const key = createSpeechCacheKey(baseConfig, text);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain(text);
    expect(createSpeechCacheKey({ ...baseConfig, sampleRate: 16_000 }, text)).not.toBe(key);
    expect(createSpeechCacheKey({ ...baseConfig, pronunciation: 'v2' }, text)).not.toBe(key);

    const plugin = createSpeechCacheOutputPlugin();
    expect(plugin.manifest.scope).toBe('session');
    expect(plugin.manifest.requires).toEqual(['ovo.cache', 'ovo.tts', 'ovo.audio-player']);
    expect(plugin.manifest.provides).toEqual(['ovo.speech-output']);
  });
});
