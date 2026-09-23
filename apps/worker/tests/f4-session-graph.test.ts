import { AgentConfig, Cap, type Behavior, type EngineEvent } from '@winsendotai/ovo-contracts';
import type { LoadedDistribution } from '@winsendotai/ovo-distribution';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { composeLiveSessionGraph, subscribeEngineTelemetry } from '../src/session-graph-runtime.ts';
import {
  WorkerSpeechCacheRuntime,
  HYBRID_SPEECH_CACHE_PLUGIN_ID,
} from '../src/speech-cache-runtime.ts';
import { recordSessionOutcome } from '../src/production-session-factory.ts';

describe('F4 selected worker session graph', () => {
  it('records a caller hangup as caller_ended', () => {
    const audit = vi.fn();
    expect(recordSessionOutcome({ audit } as never, 'caller_hangup')).toBe('ended');
    expect(audit).toHaveBeenCalledWith('session.outcome', {
      outcome: 'caller_ended',
      reason: 'caller_hangup',
    });
  });
  it.each(['context', 'agent'] as const)(
    'composes a %s release through the selected llm and engine',
    async (mode) => {
      let answered = '';
      let emit!: (event: EngineEvent) => void;
      const listeners = new Set<(event: EngineEvent) => void>();
      const inference = definePlugin(
        {
          id: 'fixture-llm',
          version: '1.2.0',
          contractVersion: 2,
          scope: 'session',
          kind: 'llm',
          provider: 'fixture',
          provides: [Cap.inference],
          requires: [],
          configSchema: { type: 'object' },
          secretFields: [],
          capabilities: { tools: true, streaming: false },
          meters: [
            {
              key: 'fixture.inference.input_tokens',
              unit: 'input_tokens',
              label: 'Input',
              role: 'llm',
            },
          ],
          runtime: { egressHosts: [], modelLicences: [] },
          conformance: ['llm@1'],
        },
        (ctx) => {
          ctx.provide(Cap.inference, {
            generate: async () => ({ kind: 'text', text: 'Selected reply' }),
          });
        },
      );
      const speech = definePlugin(
        {
          id: 'fixture-speech',
          version: '1.3.0',
          contractVersion: 1,
          scope: 'session',
          provides: [Cap.speech],
          requires: [],
          configSchema: { type: 'object' },
          secretFields: [],
        },
        (ctx) => {
          ctx.provide(Cap.speech, { speak: async () => undefined });
        },
      );
      const cacheIdentity = vi.fn(() => ({
        provider: 'fixture',
        model: 'fixture-voice',
        voice: 'default',
        revision: 'r1',
      }));
      let syntheses = 0;
      const tts = definePlugin(
        {
          id: 'fixture-tts',
          version: '1.3.0',
          contractVersion: 2,
          scope: 'session',
          kind: 'tts',
          provider: 'fixture',
          provides: [`${Cap.tts}@2`],
          requires: [],
          configSchema: { type: 'object' },
          secretFields: [],
          capabilities: {
            languages: ['en'],
            interim: false,
            wordTimestamps: false,
            turnSignals: [],
            forceEndpoint: false,
            outputFormats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
          },
          meters: [
            { key: 'fixture.tts.characters', unit: 'characters', label: 'Characters', role: 'tts' },
          ],
          runtime: { egressHosts: [], modelLicences: [] },
          conformance: ['tts@1'],
        },
        (ctx) => {
          ctx.provide(Cap.tts, {
            capabilities: {
              languages: ['en'],
              interim: false,
              wordTimestamps: false,
              turnSignals: [],
              forceEndpoint: false,
              outputFormats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
            },
            cacheIdentity,
            async *synthesize() {
              syntheses += 1;
              yield Uint8Array.of(1);
            },
          });
        },
      );
      const output = definePlugin(
        {
          id: 'fixture-output',
          version: '1.3.0',
          contractVersion: 1,
          scope: 'session',
          provides: [Cap.output],
          requires: [],
          configSchema: { type: 'object' },
          secretFields: [],
        },
        (ctx) => {
          ctx.provide(Cap.output, {
            play: async () => ({ state: 'completed', evidence: 'confirmed' }),
            interrupt: async () => undefined,
          });
        },
      );
      const engine = definePlugin(
        {
          id: 'fixture-engine',
          version: '1.3.0',
          contractVersion: 2,
          scope: 'session',
          kind: 'engine',
          provider: 'fixture',
          provides: [`${Cap.engine}@2`],
          requires: [Cap.behavior, Cap.media, Cap.output],
          companions: { [Cap.speech]: 'fixture-speech', [Cap.output]: 'fixture-output' },
          configSchema: { type: 'object' },
          secretFields: [],
          capabilities: {
            turnDetection: ['provider'],
            bargeIn: true,
            dtmf: true,
            confirmedPlayback: true,
            ownsProviders: false,
            formats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
            consumesTurnDetector: false,
          },
          runtime: { egressHosts: [], modelLicences: [] },
          conformance: ['engine@1'],
        },
        async (ctx) => {
          const behavior = ctx.get(Cap.behavior) as Behavior;
          emit = (event) => {
            for (const listener of listeners) listener(event);
          };
          ctx.provide(Cap.engine, {
            start: async () => {
              answered = await behavior.respond('hello', {});
            },
            dispose: async () => ({ reason: 'behavior_completed', outcome: 'completed' }),
            ended: Promise.resolve({ reason: 'behavior_completed', outcome: 'completed' }),
            subscribe: (listener: (event: EngineEvent) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            ingressStats: {
              acceptedFrames: 0,
              acceptedBytes: 0,
              pendingFrames: 0,
              pendingBytes: 0,
              overflows: 0,
            },
          });
        },
      );
      const parent = await compose([], []);
      const config = AgentConfig.parse({
        name: 'Selected',
        mode,
        recording: false,
        ...(mode === 'context'
          ? { speechCache: { enabled: true }, processing: { initial: 'Static phrase' } }
          : {}),
      });
      const release = {
        id: 'release-1',
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        config,
        plugins: [],
        providerBindings: {},
        mcpTools: {},
        selections: {
          engine: { pluginId: 'fixture-engine', version: '1.0.0', config: {} },
          llm: { pluginId: 'fixture-llm', version: '1.0.0', config: {} },
          tts: { pluginId: 'fixture-tts', version: '1.0.0', config: {} },
        },
      } as unknown as ReleaseRecord;
      const telemetry = {
        providerUsage: vi.fn(),
        audit: vi.fn(),
        adapter: { speech: vi.fn() },
        startStage: vi.fn(() => vi.fn()),
      };
      const marks = new Set<(name: string) => void>();
      const media = {
        sessionId: 'session-1',
        bufferedBytes: 0,
        sendAudio: vi.fn(async () => undefined),
        sendMark: vi.fn(async (name: string) => {
          for (const listener of marks) listener(name);
        }),
        clear: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        onAudio: () => () => undefined,
        onMark: (listener: (name: string) => void) => {
          marks.add(listener);
          return () => marks.delete(listener);
        },
        onDtmf: () => () => undefined,
        onClose: () => () => undefined,
      } as never;
      try {
        const selected = await composeLiveSessionGraph({
          graph: {
            distribution: {
              catalog: [inference, engine, speech, output, tts],
              defaults: { engine: 'fixture-engine' },
            } as unknown as LoadedDistribution,
            parent,
          },
          release,
          routeSessionId: 'session-1',
          variables: { caller: { name: 'Asha' } },
          media,
          operationStore: {} as never,
          secrets: {} as never,
          telemetry: telemetry as never,
          extensions: { plugins: [], nativeHandlers: {} },
          speechCache: new WorkerSpeechCacheRuntime(),
          carrierMedia: {
            carrierId: 'fixture',
            playbackEvidence: mode === 'context' ? 'carrier-processed' : 'carrier-played',
            clearFlushesMarkers: true,
          },
        });
        await selected.engine.start();
        expect(answered).toBe('Selected reply');
        if (mode === 'context') {
          expect(cacheIdentity).toHaveBeenCalled();
          expect(selected.composition.ctx.get(Cap.output)).toBeDefined();
          expect(selected.composition.lock.map((item) => item.id)).toContain(
            HYBRID_SPEECH_CACHE_PLUGIN_ID,
          );
          const selectedOutput = selected.composition.ctx.get(Cap.output) as {
            play(
              segment: {
                id: string;
                text: string;
                epoch: number;
                kind: 'acknowledgment';
                generatedAt: number;
              },
              options: { signal: AbortSignal },
            ): Promise<unknown>;
          };
          const segment = {
            id: 'static-1',
            text: 'Static phrase',
            epoch: 1,
            kind: 'acknowledgment' as const,
            generatedAt: 0,
          };
          const signal = new AbortController().signal;
          expect(await selectedOutput.play(segment, { signal })).toMatchObject({
            evidence: 'estimated',
          });
          await selectedOutput.play({ ...segment, id: 'static-2', epoch: 2 }, { signal });
          expect(syntheses).toBe(1);
        }
        const unsubscribe = subscribeEngineTelemetry(selected.engine, telemetry as never);
        emit({ type: 'end', reason: 'caller_hangup' });
        expect(telemetry.audit).toHaveBeenCalledWith('session.engine-ended', {
          reason: 'caller_hangup',
        });
        unsubscribe();
        await selected.composition.dispose();
      } finally {
        await parent.dispose();
      }
    },
  );
});
