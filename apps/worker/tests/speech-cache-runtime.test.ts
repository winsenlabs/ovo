import { describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  Cap,
  MULAW_8K,
  type AgentConfig as AgentConfigType,
  type MediaDuplex,
  type SpeechOutput,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { BoundedByteCache } from '@winsendotai/ovo-plugin-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { NormalizedTts, SpeechCacheTelemetry } from '@winsendotai/ovo-plugin-speech-cache';
import type { OpenAiTtsBinding } from '@winsendotai/ovo-plugin-providers';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import type {
  SpeechSegment,
  StreamingTts,
  VoiceMediaTransport,
} from '@winsendotai/ovo-plugin-voice';
import {
  WorkerSpeechCacheRuntime,
  approvedSpeechPhrases,
  createHybridSpeechOutput,
} from '../src/speech-cache-runtime.ts';
import { createV2SpeechCachePlugin } from '../src/speech-cache-v2.ts';
import { CachedMediaAudioPlayer } from '../src/cached-media-player.ts';

describe('worker hybrid speech cache runtime', () => {
  it('derives only configured processing phrases and the exact opted-in announcement', () => {
    const config = agent({ enabled: true, announcement: true });
    const phrases = approvedSpeechPhrases(config);

    expect(phrases).toEqual([
      { text: 'Checking now.', purpose: 'static-phrase' },
      { text: 'Still checking.', purpose: 'static-phrase' },
      { text: 'Tool starting.', purpose: 'static-phrase' },
      { text: 'Tool continues.', purpose: 'static-phrase' },
      { text: 'Exact static announcement.', purpose: 'announcement' },
    ]);
    expect(phrases.map((phrase) => phrase.text)).not.toContain('Do not cache this failure.');
    expect(phrases.map((phrase) => phrase.text)).not.toContain('Dynamic FAQ answer.');
  });

  it('generates approved audio once, plays every hit, and preserves dynamic streaming', async () => {
    const media = new FakeMedia();
    const cache = new BoundedByteCache();
    const cachedTts: NormalizedTts = {
      synthesize: vi.fn(async () => ({
        audio: new Uint8Array(320).fill(7),
        usage: {
          provider: 'openai',
          requestId: 'tts-generation-1',
          quantity: '13',
          unit: 'characters',
          state: 'estimated' as const,
        },
      })),
    };
    let streamingCalls = 0;
    const streamingTts: StreamingTts = {
      async *synthesize() {
        streamingCalls += 1;
        yield new Uint8Array(160).fill(9);
      },
    };
    const telemetry: Extract<SpeechCacheTelemetry, { type: 'cache' }>[] = [];
    const created = createHybridSpeechOutput({
      agent: agent({ enabled: true, announcement: true }),
      binding,
      cache,
      cachedTts,
      streamingTts,
      media,
      emitCache: (event) => telemetry.push(event),
    });

    await created.output.play(segment('approved-1', 'Checking now.', 'acknowledgment'), signal());
    await created.output.play(segment('approved-2', 'Checking now.', 'acknowledgment'), signal());
    await created.output.play(segment('dynamic', 'A model or tool result.', 'response'), signal());
    await created.output.play(
      segment('announcement', 'Exact static announcement.', 'response'),
      signal(),
    );
    await created.output.play(
      segment('announcement-hit', 'Exact static announcement.', 'response'),
      signal(),
    );

    expect(cachedTts.synthesize).toHaveBeenCalledTimes(2);
    expect(streamingCalls).toBe(1);
    expect(media.audioFrames).toHaveLength(9);
    expect(telemetry.map((event) => event.outcome)).toEqual(['miss', 'hit', 'miss', 'hit']);
    created.dispose();
  });

  it('keeps announcement responses streaming unless announcement caching is explicitly enabled', async () => {
    const media = new FakeMedia();
    const cachedTts: NormalizedTts = {
      synthesize: vi.fn(async () => ({
        audio: Uint8Array.of(1),
        usage: {
          provider: 'openai',
          requestId: 'unused',
          quantity: '1',
          unit: 'characters',
          state: 'estimated' as const,
        },
      })),
    };
    let streamed = 0;
    const created = createHybridSpeechOutput({
      agent: agent({ enabled: true, announcement: false }),
      binding,
      cache: new BoundedByteCache(),
      cachedTts,
      streamingTts: {
        async *synthesize() {
          streamed += 1;
          yield Uint8Array.of(2);
        },
      },
      media,
    });

    await created.output.play(
      segment('announcement', 'Exact static announcement.', 'response'),
      signal(),
    );
    expect(streamed).toBe(1);
    expect(cachedTts.synthesize).not.toHaveBeenCalled();
    created.dispose();
  });

  it('keeps the process cache bounded and returns no plugin when policy is disabled', () => {
    const runtime = new WorkerSpeechCacheRuntime({
      maxEntries: 1,
      maxBytes: 4,
      maxEntryBytes: 4,
      maxPending: 1,
    });
    expect(
      runtime.createOutputPlugin({
        agent: agent({ enabled: false }),
        binding,
      }),
    ).toBeUndefined();
    runtime.cache.set('a', 'workspace-a', Uint8Array.of(1));
    runtime.cache.set('b', 'workspace-a', Uint8Array.of(2));
    expect(runtime.cache.stats).toMatchObject({ entries: 1, bytes: 1 });
    runtime.close();
    expect(runtime.cache.stats).toMatchObject({ entries: 0, bytes: 0 });
  });
});

describe('production v2 speech cache host override', () => {
  it('prefetches approved synthesis before playback and sends whole segments in order while marks remain pending', async () => {
    const sent: string[] = [];
    const firstSend = deferred<void>();
    const stalledSynthesis = deferred<void>();
    let stallFirst = false;
    let stallFinished = false;
    let firstProduced = 0;
    const played = new Set<(name: string) => void>();
    const media = {
      sessionId: 'session-v2',
      carrierId: 'fixture',
      format: MULAW_8K,
      playbackEvidence: 'carrier-processed',
      clearFlushesMarkers: true,
      bufferedBytes: 0,
      async sendAudio(bytes: Uint8Array) {
        sent.push(`audio:${bytes[0]}`);
        if (sent.length === 1) await firstSend.promise;
      },
      async mark(name: string) {
        sent.push(`mark:${name}`);
      },
      async clear() {
        sent.push('clear');
        for (const listener of played) listener('second:1');
      },
      onPlayed(listener: (name: string) => void) {
        played.add(listener);
        return () => played.delete(listener);
      },
      onAudio: () => () => undefined,
      onCleared: () => () => undefined,
      onDtmf: () => () => undefined,
      onClose: () => () => undefined,
      close: async () => undefined,
    } satisfies MediaDuplex;
    const tts = {
      cacheIdentity: () => ({ provider: 'fixture', model: 'tts', voice: 'voice', revision: '1' }),
      async *synthesize(request: { text: string }) {
        if (request.text.startsWith('First') && stallFirst) {
          yield new Uint8Array(160).fill(1);
          await stalledSynthesis.promise;
          yield new Uint8Array(160).fill(1);
          stallFinished = true;
          return;
        }
        const value = request.text.startsWith('First')
          ? 1
          : request.text.startsWith('Second')
            ? 2
            : 3;
        for (let index = 0; index < (value === 1 ? 3 : 2); index += 1) {
          if (value === 1) firstProduced += 1;
          yield new Uint8Array(160).fill(value);
        }
      },
    } as unknown as TextToSpeech;
    const host = definePlugin(
      {
        id: 'fixture-v2-cache-host',
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'host',
        requires: [],
        provides: [Cap.tts, Cap.media, Cap.usage],
        configSchema: { type: 'object', additionalProperties: false },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.tts, tts);
        ctx.provide(Cap.media, media);
        ctx.provide(Cap.usage, () => undefined);
      },
    );
    const release = {
      id: 'release-v2-cache',
      workspaceId: 'workspace-a',
      config: AgentConfig.parse({
        name: 'Cache overlap',
        mode: 'announcement',
        message: 'Uncached announcement.',
        voice: { acknowledgements: ['weak-playback-evidence'] },
        speechCache: { enabled: true },
        processing: { initial: 'First approved.', progress: 'Second approved.' },
      }),
      providerBindings: {},
      plugins: [],
    } as unknown as ReleaseRecord;
    const cache = new BoundedByteCache({ maxPending: 1 });
    const plugin = createV2SpeechCachePlugin(release, cache);
    const composition = await compose(
      [{ id: host.manifest.id }, { id: plugin!.manifest.id }],
      [host, plugin!],
      { scope: 'session' },
    );
    try {
      const output = composition.get(Cap.output) as SpeechOutput & {
        configure(options: { maxPrefetchBytes: number }): void;
      };
      output.configure({ maxPrefetchBytes: 160 });
      const first = segment('first', 'First approved.', 'acknowledgment');
      const second = segment('second', 'Second approved.', 'acknowledgment');
      const dynamic = segment('dynamic', 'Dynamic response.', 'response');
      const controller = new AbortController();
      expect(output.prepare).toBeTypeOf('function');
      await Promise.all([
        output.prepare!(first, controller.signal),
        output.prepare!(second, controller.signal),
      ]);
      await vi.waitFor(() => expect(firstProduced).toBe(2));
      const firstResult = output.play(first, { signal: controller.signal });
      const secondResult = output.play(second, { signal: controller.signal });
      const dynamicResult = output.play(dynamic, { signal: controller.signal });
      await vi.waitFor(() => expect(sent).toContain('audio:1'));
      firstSend.resolve();
      await vi.waitFor(() => expect(sent).toContain('mark:dynamic:1'));
      expect(sent.join(',')).toBe(
        'audio:1,audio:1,audio:1,mark:first:1:cache,audio:2,audio:2,mark:second:1,audio:3,audio:3,mark:dynamic:1',
      );
      for (const listener of played) listener('first:1:cache');
      expect(await firstResult).toMatchObject({ state: 'completed', evidence: 'confirmed' });
      await output.interrupt(1);
      expect(sent.at(-1)).toBe('clear');
      expect(await secondResult).toMatchObject({ state: 'interrupted', evidence: 'estimated' });
      expect(await dynamicResult).toMatchObject({ state: 'interrupted', evidence: 'estimated' });
      cache.invalidateWorkspace('workspace-a');
      stallFirst = true;
      const before = sent.filter((entry) => entry === 'audio:1').length;
      const stalled = { ...segment('stalled', 'First approved.', 'acknowledgment'), epoch: 2 };
      const firstAbort = new AbortController();
      const stalledResult = output.play(stalled, { signal: firstAbort.signal });
      await vi.waitFor(() =>
        expect(sent.filter((entry) => entry === 'audio:1')).toHaveLength(before + 1),
      );
      expect(stallFinished).toBe(false);
      const survivor = { ...segment('survivor', 'First approved.', 'acknowledgment'), epoch: 2 };
      const survivorResult = output.play(survivor, { signal: controller.signal });
      firstAbort.abort(new DOMException('first caller left', 'AbortError'));
      expect(await stalledResult).toMatchObject({ state: 'interrupted' });
      stalledSynthesis.resolve();
      await vi.waitFor(() => expect(sent).toContain('mark:survivor:2:cache'));
      for (const listener of played) listener('survivor:2:cache');
      expect(await survivorResult).toMatchObject({ state: 'completed', evidence: 'confirmed' });
    } finally {
      firstSend.resolve();
      stalledSynthesis.resolve();
      await composition.dispose();
    }
  });

  it('settles an unacknowledged mark timeout as completed with estimated evidence', async () => {
    const markSent = deferred<void>();
    const media = Object.assign(new FakeMedia(), {
      bufferedBytes: 160_000,
      sendMark: async (_name: string) => markSent.resolve(),
    });
    const player = new CachedMediaAudioPlayer(media, {
      markTimeoutMs: 1,
      playbackEvidence: 'carrier-processed',
      allowWeakEvidence: true,
    });
    vi.useFakeTimers();
    try {
      let settled = false;
      const playback = playCached(player, 'timeout').then((result) => {
        settled = true;
        return result;
      });
      await markSent.promise;
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await playback).toMatchObject({ state: 'completed', evidence: 'estimated' });
    } finally {
      player.dispose();
      vi.useRealTimers();
    }
  });

  it('accepts carrier-processed evidence only with the weak-evidence acknowledgement', async () => {
    const acknowledged = new CachedMediaAudioPlayer(new FakeMedia(), {
      playbackEvidence: 'carrier-processed',
      allowWeakEvidence: true,
    });
    const weak = await playCached(acknowledged, 'weak');
    expect(weak).toMatchObject({ state: 'completed', evidence: 'confirmed' });
    acknowledged.dispose();
    const unacknowledged = new CachedMediaAudioPlayer(new FakeMedia(), {
      playbackEvidence: 'carrier-processed',
    });
    const weakWithoutConsent = await playCached(unacknowledged, 'no-weak');
    expect(weakWithoutConsent).toMatchObject({ state: 'completed', evidence: 'estimated' });
    unacknowledged.dispose();
  });
});

function playCached(player: CachedMediaAudioPlayer, id: string) {
  return player.play(
    {
      audio: Uint8Array.of(1),
      codec: 'audio/x-mulaw',
      sampleRate: 8_000,
      segment: segment(id, 'First approved.', 'acknowledgment'),
    },
    signal(),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const binding: OpenAiTtsBinding = {
  workspaceId: 'workspace-a',
  bindingVersion: 'binding:v1',
  credentialId: 'credential-a',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  speed: 1,
  requestTimeoutMs: 10_000,
  maxInputCharacters: 10_000,
  maxResponseBytes: 1_000_000,
  maxOutputChunkBytes: 8_192,
};

function agent(policy: { enabled: boolean; announcement?: boolean }): AgentConfigType {
  return AgentConfig.parse({
    name: 'Cache policy',
    mode: 'announcement',
    message: 'Exact static announcement.',
    speechCache: policy,
    faq: [{ id: 'faq', question: 'Question?', answer: 'Dynamic FAQ answer.' }],
    processing: {
      initial: 'Checking now.',
      progress: 'Still checking.',
      progressAfterMs: 5_000,
      maxProgress: 1,
      failure: 'Do not cache this failure.',
    },
    tools: [
      {
        id: 'lookup',
        description: 'Lookup',
        connector: 'native',
        inputSchema: {},
        effect: 'read',
        processing: {
          initial: 'Tool starting.',
          progress: 'Tool continues.',
          progressAfterMs: 5_000,
          maxProgress: 1,
          failure: 'Tool failed.',
        },
      },
    ],
  });
}

function segment(id: string, text: string, kind: SpeechSegment['kind']): SpeechSegment {
  return { id, text, kind, epoch: 1, generatedAt: Date.now() };
}

function signal() {
  return { signal: new AbortController().signal };
}

class FakeMedia implements VoiceMediaTransport {
  readonly sessionId = 'session-a';
  readonly bufferedBytes = 0;
  readonly audioFrames: Uint8Array[] = [];
  readonly marks: string[] = [];
  private readonly markListeners = new Set<(name: string) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();

  async sendAudio(audio: Uint8Array): Promise<void> {
    this.audioFrames.push(audio.slice());
  }
  async sendMark(name: string): Promise<void> {
    this.marks.push(name);
    for (const listener of this.markListeners) listener(name);
  }
  async clear(): Promise<void> {}
  onAudio = () => () => undefined;
  onMark(listener: (name: string) => void): () => void {
    this.markListeners.add(listener);
    return () => this.markListeners.delete(listener);
  }
  onDtmf = () => () => undefined;
  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  async close(reason: string): Promise<void> {
    for (const listener of this.closeListeners) listener(reason);
  }
}
