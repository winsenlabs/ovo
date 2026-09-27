import { describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  Cap,
  MULAW_8K,
  PCM16_16K,
  type AudioFormat,
  type EngineEvent,
  type SynthesisInput,
  type TextToSpeech,
  type VoiceMediaTransport,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { withEgressSentinel } from '@winsendotai/ovo-conformance/drivers';
import { loadDistribution } from '../../distribution/src/index.ts';
import { NativeVoiceSessionEngine } from '../../plugin-voice/src/index.ts';
import type { ReleaseRecord } from '../../plugin-storage/src/index.ts';
import { ProductionVoiceSessionFactory } from '../../../apps/worker/src/production-session-factory.ts';
import { WorkerSpeechCacheRuntime } from '../../../apps/worker/src/speech-cache-runtime.ts';

const message = 'This approved announcement is cached.';
const nativeEngineId = '@winsendotai/ovo-plugin-voice-session-engine';

describe('native production worker speech cache', () => {
  it.each([MULAW_8K, PCM16_16K])(
    'reuses synthesis across real native sessions in negotiated $encoding/$sampleRate',
    (format) =>
      withEgressSentinel(
        async (sentinel) => {
          const bytes = Uint8Array.from(
            { length: format.sampleRate * (format.encoding === 'pcm_s16le' ? 2 : 1) * 0.02 },
            (_, index) => (index * 7 + 17) % 256,
          );
          const synthesize = vi.fn(async function* (request: SynthesisInput) {
            request.signal.throwIfAborted();
            yield bytes.slice();
          });
          const tts = fixtureTts(synthesize);
          const distribution = await loadDistribution({
            role: 'worker',
            profile: 'compose',
            env: {
              DATABASE_URL: 'postgres://unused:unused@127.0.0.1/unused',
              OVO_QUEUE_URL: 'http://127.0.0.1/unused',
              AWS_REGION: 'us-east-1',
            },
          });
          const native = distribution.catalog.find(
            (plugin) => plugin.manifest.id === nativeEngineId,
          );
          expect(native?.manifest.contractVersion).toBe(2);
          const release = releaseFor(tts.manifest.id);
          const parent = await compose([], []);
          const cache = new WorkerSpeechCacheRuntime();
          const events: EngineEvent[] = [];
          const starts = vi.spyOn(NativeVoiceSessionEngine.prototype, 'start');
          const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('unexpected egress'));
          const factory = new ProductionVoiceSessionFactory(
            {
              getRelease: async () => release,
              getCall: async (_workspaceId: string, id: string) => ({
                id,
                workspaceId: release.workspaceId,
                releaseId: release.id,
                kind: 'live',
                status: 'active',
              }),
              operationStore: {},
            } as never,
            { forAgent: () => ({ resolve: vi.fn() }) } as never,
            {
              createSession: async () => ({
                audit: vi.fn(),
                providerUsage: vi.fn(),
                startStage: () => () => true,
                withOperationStore: (store: unknown) => store,
                adapter: { speech: vi.fn() },
                engineEvent: (event: EngineEvent) => events.push(event),
                close: vi.fn(async () => undefined),
              }),
            } as never,
            undefined,
            undefined,
            // Only TTS is supplied by the test; behavior, scheduler and engine come from production.
            { plugins: [tts], nativeHandlers: {} },
            undefined,
            30,
            cache,
            {
              distribution,
              parent,
              carriers: {
                forJob: async () => ({
                  carrier: {
                    carrierId: 'fixture',
                    capabilities: {
                      media: {
                        formats: [MULAW_8K, PCM16_16K],
                        playbackEvidence: 'carrier-played',
                        clearFlushesMarkers: true,
                      },
                    },
                  },
                }),
              } as never,
            },
          );
          try {
            for (const id of ['first', 'second']) {
              const carrier = mediaTransport(id, format);
              const session = await factory.create({
                job: {
                  id,
                  workspaceId: release.workspaceId,
                  payload: { releaseId: release.id, callId: id },
                } as never,
                route: { sessionId: id, generation: 1, carrierId: 'fixture' } as never,
                media: carrier.media as never,
              });
              try {
                await vi.waitFor(() =>
                  expect(carrier.media.close).toHaveBeenCalledWith('behavior_completed'),
                );
                expect(Buffer.concat(carrier.frames)).toEqual(Buffer.from(bytes));
                expect(carrier.marks.length).toBeGreaterThan(0);
              } finally {
                await session.dispose('behavior_completed');
              }
            }
            expect(starts).toHaveBeenCalledTimes(2);
            expect(synthesize).toHaveBeenCalledOnce();
            expect(synthesize.mock.calls[0]![0]).toMatchObject({
              sessionId: 'first',
              text: message,
              format,
              language: release.config.language,
              voice: 'fixture-voice',
            });
            expect(cache.cache.stats).toMatchObject({
              entries: 1,
              bytes: bytes.byteLength,
              pending: 0,
            });
            expect(events.filter((event) => event.type === 'end')).toEqual([
              { type: 'end', reason: 'behavior_completed' },
              { type: 'end', reason: 'behavior_completed' },
            ]);
            expect(
              events.filter(
                (event) => event.type === 'agent.transcript' && event.state === 'played',
              ),
            ).toEqual([
              expect.objectContaining({ text: message }),
              expect.objectContaining({ text: message }),
            ]);
            expect(fetch).not.toHaveBeenCalled();
            expect(sentinel.attempts).toEqual([]);
          } finally {
            fetch.mockRestore();
            starts.mockRestore();
            cache.close();
            await parent.dispose();
          }
        },
        { allowLoopback: false },
      ),
  );
});

function fixtureTts(synthesize: TextToSpeech['synthesize']) {
  const capabilities = {
    outputFormats: [MULAW_8K, PCM16_16K],
    languages: ['en-IN'],
    interim: false,
    wordTimestamps: false,
    turnSignals: [],
    forceEndpoint: false,
  } as const;
  return definePlugin(
    {
      id: '@fixture/native-worker-cache-tts',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'tts',
      provider: 'fixture-cache',
      provides: [Cap.tts + '@2'],
      requires: [],
      configSchema: { type: 'object', additionalProperties: true },
      secretFields: [],
      capabilities,
      conformance: ['tts@1'],
      meters: [{ key: 'fixture.tts.text', unit: 'characters', label: 'Text', role: 'tts' }],
      runtime: { egressHosts: [], modelLicences: [] },
    },
    (ctx) => {
      // Each session receives its own service because production telemetry decorates it.
      ctx.provide(Cap.tts, {
        capabilities,
        cacheIdentity: (_format, voice) => ({
          provider: 'fixture-cache',
          model: 'local-tts',
          voice: voice ?? 'fixture-voice',
          revision: '1',
        }),
        synthesize,
      } satisfies TextToSpeech);
    },
  );
}

function releaseFor(ttsId: string): ReleaseRecord {
  return {
    id: 'release-cache',
    workspaceId: 'workspace-cache',
    agentId: 'agent-cache',
    draftVersion: 1,
    config: AgentConfig.parse({
      name: 'Cached production announcement',
      mode: 'announcement',
      message,
      recording: false,
      speechCache: { enabled: true, announcement: true },
    }),
    plugins: [{ id: '@winsendotai/ovo-behavior-announcement', version: '0.1.0' }],
    selections: {
      engine: { pluginId: nativeEngineId, version: '0.1.0', config: {} },
      tts: { pluginId: ttsId, version: '1.0.0', config: { voice: 'fixture-voice' } },
    },
    providerBindings: {},
    mcpTools: {},
    createdAt: '2026-09-27T00:00:00.000Z',
    createdBy: 'test',
  };
}

function mediaTransport(sessionId: string, format: AudioFormat) {
  const frames: Uint8Array[] = [];
  const marks: string[] = [];
  const played = new Set<(name: string) => void>();
  const closed = new Set<(reason: string) => void>();
  const media = {
    sessionId,
    format,
    bufferedBytes: 0,
    async sendAudio(bytes: Uint8Array) {
      frames.push(bytes.slice());
    },
    async sendMark(name: string) {
      marks.push(name);
      queueMicrotask(() => {
        for (const listener of played) listener(name);
      });
    },
    clear: async () => undefined,
    onAudio: () => () => undefined,
    onDtmf: () => () => undefined,
    onMark(listener: (name: string) => void) {
      played.add(listener);
      return () => played.delete(listener);
    },
    onClose(listener: (reason: string) => void) {
      closed.add(listener);
      return () => closed.delete(listener);
    },
    close: vi.fn(async (reason: string) => {
      for (const listener of closed) listener(reason);
    }),
  } satisfies VoiceMediaTransport & { format: AudioFormat };
  return { media, frames, marks };
}
