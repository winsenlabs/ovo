import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  Cap,
  MULAW_8K,
  type MediaDuplex,
  type SpeechOutput,
  type SpeechSegment,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { WorkerSpeechCacheRuntime } from '../src/speech-cache-runtime.ts';
import { createV2SpeechCachePlugin } from '../src/speech-cache-v2.ts';

/**
 * LAT-1: the live worker output streams synthesized audio to the carrier chunk by chunk. First
 * audio is bounded by the provider's time to first byte, not by the time to synthesize a sentence.
 * Both branches of the live speech output are driven: dynamic speech goes straight from the
 * provider, and an approved phrase that misses the cache streams while the cache is filled.
 */
describe('live speech output streaming', () => {
  it.each([
    {
      branch: 'dynamic response',
      text: 'Your balance is ready.',
      kind: 'response' as const,
      mark: 'speech-1:1',
    },
    {
      branch: 'cache-miss fill',
      text: 'One moment please.',
      kind: 'acknowledgment' as const,
      mark: 'speech-1:1:cache',
    },
  ])(
    'sends first carrier audio while synthesis is still running ($branch)',
    async ({ text, kind, mark }) => {
      const order: string[] = [];
      const marks: string[] = [];
      const played = new Set<(name: string) => void>();
      const media = {
        sessionId: 'session-1',
        carrierId: 'fixture',
        format: MULAW_8K,
        playbackEvidence: 'carrier-played',
        clearFlushesMarkers: true,
        bufferedBytes: 0,
        async sendAudio() {
          order.push('carrier:audio');
        },
        async mark(name: string) {
          marks.push(name);
          queueMicrotask(() => {
            for (const listener of played) listener(name);
          });
        },
        async clear() {},
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
      let finishSynthesis!: () => void;
      const synthesisGate = new Promise<void>((resolve) => (finishSynthesis = resolve));
      const tts = {
        cacheIdentity: () => ({ provider: 'fixture', model: 'tts', voice: 'voice', revision: '1' }),
        async *synthesize() {
          order.push('tts:first-chunk');
          yield new Uint8Array(320).fill(0xff);
          await synthesisGate;
          order.push('tts:last-chunk');
          yield new Uint8Array(320).fill(0xff);
          order.push('tts:done');
        },
      } as unknown as TextToSpeech;
      const host = definePlugin(
        {
          id: 'fixture-first-audio-host',
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
        id: 'release-first-audio',
        agentId: 'agent-first-audio',
        draftVersion: 1,
        mcpTools: {},
        createdAt: '2026-10-06T00:00:00.000Z',
        createdBy: 'test',
        workspaceId: 'workspace-a',
        config: AgentConfig.parse({
          name: 'First audio',
          mode: 'announcement',
          message: 'Your call is important.',
          speechCache: { enabled: true },
          processing: { initial: 'One moment please.' },
        }),
        providerBindings: {},
        plugins: [],
      } satisfies Parameters<typeof createV2SpeechCachePlugin>[0];
      const plugin = createV2SpeechCachePlugin(release, new WorkerSpeechCacheRuntime().cache);
      const composition = await compose(
        [{ id: host.manifest.id }, { id: plugin!.manifest.id }],
        [host, plugin!],
        { scope: 'session' },
      );
      try {
        const output = composition.get(Cap.output) as SpeechOutput & {
          configureTiming(listener: (phase: string) => void): void;
        };
        const timing: string[] = [];
        output.configureTiming((phase) => timing.push(phase));
        const segment: SpeechSegment = { id: 'speech-1', text, kind, epoch: 1, generatedAt: 0 };

        const result = output.play(segment, { signal: new AbortController().signal });
        await until(() => order.includes('carrier:audio'));

        // The provider is still holding the rest of the sentence when the caller starts hearing it.
        expect(order[0]).toBe('tts:first-chunk');
        expect(order).not.toContain('tts:last-chunk');
        expect(timing).toEqual(['tts-first-byte', 'carrier-first-audio']);
        finishSynthesis();
        await expect(result).resolves.toMatchObject({ state: 'completed', evidence: 'confirmed' });
        expect(order.indexOf('tts:done')).toBeGreaterThan(order.indexOf('carrier:audio'));
        expect(marks).toEqual([mark]);
      } finally {
        finishSynthesis();
        await composition.dispose();
      }
    },
  );
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
