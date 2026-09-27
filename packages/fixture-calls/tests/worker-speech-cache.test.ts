import { describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  Cap,
  MULAW_8K,
  PCM16_16K,
  type MediaDuplex,
  type SpeechOutput,
  type SpeechSegment,
  type TextToSpeech,
  type VoiceMediaTransport,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { WorkerSpeechCacheRuntime } from '../../../apps/worker/src/speech-cache-runtime.ts';
import { createV2SpeechCachePlugin } from '../../../apps/worker/src/speech-cache-v2.ts';
import { CachedMediaAudioPlayer } from '../../../apps/worker/src/cached-media-player.ts';
describe('production v2 speech cache host override', () => {
  it.each([MULAW_8K, PCM16_16K])(
    'prefetches both branches with negotiated $encoding/$sampleRate and preserves ordered sends',
    async (format) => {
      const sent: string[] = [];
      const firstSend = deferred<void>();
      const stalledSynthesis = deferred<void>();
      const lateSend = deferred<void>();
      let blockNext = false;
      let stallFirst = false;
      let stallFinished = false;
      let firstProduced = 0;
      let secondProduced = 0;
      const played = new Set<(name: string) => void>();
      const media = {
        sessionId: 'session-v2',
        carrierId: 'fixture',
        format,
        playbackEvidence: 'carrier-processed',
        clearFlushesMarkers: true,
        bufferedBytes: 0,
        async sendAudio(bytes: Uint8Array) {
          sent.push(`audio:${bytes[0]}`);
          if (sent.length === 1) await firstSend.promise;
          if (blockNext) {
            blockNext = false;
            await lateSend.promise;
            sent.push('send-returned');
          }
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
        cacheIdentity: (actual: unknown) => {
          expect(actual).toEqual(format);
          return { provider: 'fixture', model: 'tts', voice: 'voice', revision: '1' };
        },
        async *synthesize(request: { text: string; format: unknown }) {
          expect(request.format).toEqual(format);
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
            if (value === 2) secondProduced += 1;
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
        agentId: 'agent-v2-cache',
        draftVersion: 1,
        mcpTools: {},
        createdAt: '2026-09-26T00:00:00.000Z',
        createdBy: 'test',
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
      } satisfies Parameters<typeof createV2SpeechCachePlugin>[0];
      const cache = new WorkerSpeechCacheRuntime({ maxPending: 1 }).cache;
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
        await vi.waitFor(() => expect(secondProduced).toBe(2));
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
        blockNext = true;
        const offset = sent.length;
        const late = output.play(
          { ...segment('late', 'Dynamic response.', 'response'), epoch: 3 },
          signal(),
        );
        const queued = output.play(
          { ...segment('queued', 'Dynamic response.', 'response'), epoch: 3 },
          signal(),
        );
        await vi.waitFor(() => expect(sent.length).toBe(offset + 1));
        const clear = output.interrupt(3);
        const next = output.play(
          { ...segment('next', 'Dynamic response.', 'response'), epoch: 4 },
          signal(),
        );
        await Promise.resolve();
        expect(sent.slice(offset)).toEqual(['audio:3']);
        lateSend.resolve();
        await clear;
        await vi.waitFor(() => expect(sent.at(-1)).toBe('mark:next:4'));
        expect(sent.slice(offset)).toEqual([
          'audio:3',
          'send-returned',
          'clear',
          'audio:3',
          'audio:3',
          'mark:next:4',
        ]);
        expect(await late).toMatchObject({ state: 'interrupted' });
        expect(await queued).toMatchObject({ state: 'interrupted' });
        for (const listener of played) listener('next:4');
        expect(await next).toMatchObject({ state: 'completed' });
      } finally {
        firstSend.resolve();
        lateSend.resolve();
        stalledSynthesis.resolve();
        await composition.dispose();
      }
    },
  );

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
    expect(weak).toMatchObject({
      state: 'completed',
      evidence: 'confirmed',
      evidenceSource: 'carrier-processed',
    });
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
