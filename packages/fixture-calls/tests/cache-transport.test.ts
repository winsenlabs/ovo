import { expect, it } from 'vitest';
import {
  AgentConfig,
  Cap,
  MULAW_8K,
  PCM16_16K,
  type AudioFormat,
  type MediaDuplex,
  type SpeechOutput,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { WorkerSpeechCacheRuntime } from '../../../apps/worker/src/speech-cache-runtime.ts';
import { createV2SpeechCachePlugin } from '../../../apps/worker/src/speech-cache-v2.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function open(format: AudioFormat, tts: TextToSpeech, sendAudio: MediaDuplex['sendAudio']) {
  const played = new Set<(name: string) => void>();
  const media: MediaDuplex = {
    sessionId: 'cache-transport',
    carrierId: 'test',
    format,
    playbackEvidence: 'carrier-played',
    clearFlushesMarkers: true,
    bufferedBytes: 0,
    sendAudio,
    mark: async (name) => {
      for (const fn of played) fn(name);
    },
    clear: async () => undefined,
    close: async () => undefined,
    onPlayed: (fn) => {
      played.add(fn);
      return () => {
        played.delete(fn);
      };
    },
    onAudio: () => () => undefined,
    onClose: () => () => undefined,
    onDtmf: () => () => undefined,
    onCleared: () => () => undefined,
  };
  const host = definePlugin(
    {
      id: 'cache-transport-host',
      version: '1.0.0',
      contractVersion: 2,
      kind: 'host',
      scope: 'session',
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
  const plugin = createV2SpeechCachePlugin(
    {
      id: 'cache-release',
      agentId: 'agent',
      workspaceId: 'w',
      draftVersion: 1,
      plugins: [],
      providerBindings: {},
      mcpTools: {},
      createdAt: '2026-09-26T00:00:00Z',
      createdBy: 'test',
      config: AgentConfig.parse({
        name: 'Cache framing',
        mode: 'announcement',
        message: 'Announcement',
        processing: { initial: 'Cache me.' },
        speechCache: { enabled: true },
      }),
    },
    new WorkerSpeechCacheRuntime().cache,
  )!;
  const composition = await compose(
    [{ id: host.manifest.id }, { id: plugin.manifest.id }],
    [host, plugin],
    { scope: 'session' },
  );
  return {
    output: composition.get(Cap.output) as SpeechOutput,
    close: () => composition.dispose(),
  };
}
const segment = (id: string, text = 'Cache me.') => ({
  id,
  text,
  kind: 'acknowledgment' as const,
  epoch: 1,
  generatedAt: 0,
});

it.each(
  [MULAW_8K, PCM16_16K].flatMap((format) => ['coalesced', 'hit'].map((path) => ({ format, path }))),
)(
  'reframes large $path separately from the prefetch budget ($format.encoding)',
  async ({ format, path }) => {
    const firstByte = deferred(),
      continueAudio = deferred();
    const bytes = Uint8Array.from({ length: 80_000 }, (_, index) => index % 251);
    let syntheses = 0;
    const received: Uint8Array[] = [];
    const tts = {
      cacheIdentity: () => ({ provider: 'test', model: 'test', voice: 'test', revision: '1' }),
      async *synthesize() {
        syntheses++;
        yield bytes.slice(0, 1000);
        firstByte.resolve();
        await continueAudio.promise;
        for (let offset = 1000; offset < bytes.length; offset += 1000)
          yield bytes.slice(offset, offset + 1000);
      },
    } as unknown as TextToSpeech;
    const { output, close } = await open(format, tts, async (frame) => {
      if (frame.length > 8192) throw new Error('audio frame exceeds limit');
      expect(frame.length % (format.encoding === 'pcm_s16le' ? 2 : 1)).toBe(0);
      received.push(frame.slice());
    });
    const signal = new AbortController().signal;
    try {
      await output.prepare!(segment('miss'), signal);
      await firstByte.promise;
      if (path === 'coalesced') await output.prepare!(segment('coalesced'), signal);
      continueAudio.resolve();
      await output.play(segment('miss'), { signal });
      const initialFrames = received.length;
      expect(initialFrames).toBeGreaterThan(0);
      await output.play(segment(path), { signal });
      expect(syntheses).toBe(1);
      const joined = Uint8Array.from(received.flatMap((frame) => [...frame]));
      expect(joined.length).toBe(bytes.length * 2);
      for (let n = 0; n < 2; n++)
        expect(joined.slice(n * bytes.length, (n + 1) * bytes.length)).toEqual(bytes);
    } finally {
      continueAudio.resolve();
      await close();
    }
  },
);
it('aborts dynamic TTS when the production cache output loses its carrier transport', async () => {
  let producerSignal: AbortSignal | undefined;
  const stopped = deferred();
  const tts = {
    cacheIdentity: () => ({ provider: 'test', model: 'test', voice: 'test', revision: '1' }),
    async *synthesize(request: { signal: AbortSignal }) {
      producerSignal = request.signal;
      yield new Uint8Array(160);
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      stopped.resolve();
    },
  } as unknown as TextToSpeech;
  const { output, close } = await open(MULAW_8K, tts, async () => {
    throw new Error('transport disconnected');
  });
  try {
    await expect(
      output.play(segment('dynamic', 'Uncached response'), {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('transport disconnected');
    expect(producerSignal?.aborted).toBe(true);
    await stopped.promise;
  } finally {
    await close();
  }
});

it.each(['before play', 'during prepare'])(
  'refuses a play signal aborted %s for a previously prepared segment',
  async (timing) => {
    let sent = 0;
    const tts = {
      cacheIdentity: () => ({ provider: 'test', model: 'test', voice: 'test', revision: '1' }),
      async *synthesize() {
        yield new Uint8Array(160);
      },
    } as unknown as TextToSpeech;
    const { output, close } = await open(MULAW_8K, tts, async () => {
      sent++;
    });
    try {
      const speech = segment('different-signal', 'Dynamic text');
      await output.prepare!(speech, new AbortController().signal);
      const controller = new AbortController();
      if (timing === 'before play') controller.abort();
      const played = output.play(speech, { signal: controller.signal });
      if (timing === 'during prepare') controller.abort();
      expect(await played).toMatchObject({ state: 'interrupted' });
      expect(sent).toBe(0);
    } finally {
      await close();
    }
  },
);
it('joins split PCM samples before sending bounded carrier frames', async () => {
  const frames: number[][] = [];
  const tts = {
    cacheIdentity: () => ({ provider: 'test', model: 'test', voice: 'test', revision: '1' }),
    async *synthesize() {
      yield Uint8Array.of(1);
      yield Uint8Array.of(2, 3, 4);
    },
  } as unknown as TextToSpeech;
  const { output, close } = await open(PCM16_16K, tts, async (frame) => {
    expect(frame.length % 2).toBe(0);
    frames.push([...frame]);
  });
  try {
    await output.play(segment('pcm', 'Dynamic PCM'), { signal: new AbortController().signal });
    expect(frames.flat()).toEqual([1, 2, 3, 4]);
  } finally {
    await close();
  }
});
