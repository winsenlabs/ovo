import { AgentConfig, Cap, MULAW_8K, type SttEvent } from '@winsendotai/ovo-contracts';
import { FIRST_PARTY, loadDistribution } from '@winsendotai/ovo-distribution';
import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { WorkerMediaSession } from '@winsendotai/ovo-plugin-media';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { WorkerMediaRuntime } from '../src/media-runtime.ts';
import { ProductionVoiceSessionFactory } from '../src/production-session-factory.ts';

describe('input-enabled production session lifecycle', () => {
  it('ends an input-enabled selected release through the real native engine and telemetry STT', async () => {
    const order: string[] = [];
    const cancel = vi.fn(async () => undefined);
    const finish = vi.fn(async () => undefined);
    const sttStart = vi.fn();
    const stt = definePlugin(
      {
        id: '@fixture/lifecycle-stt',
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'stt',
        provider: 'fixture',
        provides: [`${Cap.stt}@2`],
        requires: [],
        optional: [],
        configSchema: { type: 'object' },
        secretFields: [],
        capabilities: {
          inputFormats: [MULAW_8K],
          languages: ['*'],
          interim: true,
          wordTimestamps: false,
          turnSignals: ['end-of-turn'],
          forceEndpoint: false,
        },
        meters: [{ key: 'fixture.stt.audio', unit: 'audio_seconds', label: 'Audio', role: 'stt' }],
        runtime: { egressHosts: [], modelLicences: [] },
        conformance: ['stt@1'],
      },
      (ctx) => {
        ctx.provide(Cap.stt, {
          capabilities: {
            inputFormats: [MULAW_8K],
            languages: ['*'],
            interim: true,
            wordTimestamps: false,
            turnSignals: ['end-of-turn'],
            forceEndpoint: false,
          },
          start: async (input: { onEvent: (event: SttEvent) => void }) => {
            sttStart();
            return {
              write: async () => {
                input.onEvent({
                  type: 'transcript',
                  segment: { segmentId: 'answer', revision: 1, text: '1', stability: 'final' },
                });
                input.onEvent({ type: 'end-of-turn' });
              },
              finish,
              cancel,
            };
          },
        });
      },
    );
    const tts = definePlugin(
      {
        id: '@fixture/lifecycle-tts',
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'tts',
        provider: 'fixture',
        provides: [`${Cap.tts}@2`],
        requires: [],
        optional: [],
        configSchema: { type: 'object' },
        secretFields: [],
        capabilities: {
          outputFormats: [MULAW_8K],
          languages: ['*'],
          interim: false,
          wordTimestamps: false,
          turnSignals: [],
          forceEndpoint: false,
        },
        meters: [{ key: 'fixture.tts.text', unit: 'characters', label: 'Text', role: 'tts' }],
        runtime: { egressHosts: [], modelLicences: [] },
        conformance: ['tts@1'],
      },
      (ctx) => {
        ctx.provide(Cap.tts, {
          capabilities: {
            outputFormats: [MULAW_8K],
            languages: ['*'],
            interim: false,
            wordTimestamps: false,
            turnSignals: [],
            forceEndpoint: false,
          },
          cacheIdentity: () => ({
            provider: 'fixture',
            model: 'fixture',
            voice: '',
            revision: '1',
          }),
          async *synthesize() {
            yield Uint8Array.of(1, 2, 3);
          },
        });
      },
    );
    const distribution = await loadDistribution({
      role: 'worker',
      profile: 'compose',
      env: {
        DATABASE_URL: 'postgres://unused:unused@127.0.0.1/unused',
        OVO_QUEUE_URL: 'http://127.0.0.1/unused',
        AWS_REGION: 'us-east-1',
      },
      firstParty: [
        ...FIRST_PARTY,
        {
          package: '@fixture/lifecycle-stt',
          roles: ['session'],
          load: async () => ({ plugins: [stt] }),
        },
        {
          package: '@fixture/lifecycle-tts',
          roles: ['session'],
          load: async () => ({ plugins: [tts] }),
        },
      ],
    });
    const parent = await compose([], []);
    const config = AgentConfig.parse({
      name: 'Input lifecycle',
      mode: 'faq',
      faq: [],
      recording: false,
      script: {
        start: 'start',
        nodes: [
          {
            id: 'start',
            prompt: 'Press one.',
            transitions: [{ event: 'text', matches: ['1'], to: 'done' }],
          },
          { id: 'done', prompt: 'Thank you.', terminal: true },
        ],
      },
      voice: {
        engine: { plugin: '@winsendotai/ovo-plugin-voice-session-engine', config: {} },
        stt: { plugin: stt.manifest.id, binding: 'env', config: {} },
        tts: { plugin: tts.manifest.id, binding: 'env', config: {} },
      },
    });
    const release = {
      id: 'release-input',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      config,
      plugins: [{ id: '@winsendotai/ovo-behavior-faq', version: '0.1.0' }],
      selections: {
        engine: {
          pluginId: '@winsendotai/ovo-plugin-voice-session-engine',
          version: '0.1.0',
          config: {},
        },
        stt: {
          pluginId: stt.manifest.id,
          version: stt.manifest.version,
          bindingId: 'env',
          config: {},
        },
        tts: {
          pluginId: tts.manifest.id,
          version: tts.manifest.version,
          bindingId: 'env',
          config: {},
        },
      },
      providerBindings: {},
      mcpTools: {},
      draftVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'operator-1',
    } as ReleaseRecord;
    const route = {
      sessionId: 'session-input',
      jobId: 'job-input',
      organizationId: 'workspace-1',
      workerId: 'worker-1',
      workerEndpoint: 'ws://worker-1/internal/media',
      ownerEpoch: 7,
      generation: 2,
      dialRequestId: 'job-input:7',
      carrierCallId: 'CA-input',
      carrierId: 'fixture',
      status: 'accepted',
      handshakeExpiresAt: new Date(Date.now() + 60_000),
    } as SessionRoute;
    const job = {
      id: 'job-input',
      workspaceId: 'workspace-1',
      idempotencyKey: 'job-input',
      payload: { releaseId: release.id, callId: 'call-input' },
      status: 'accepted',
      ownerId: route.workerId,
      ownerEpoch: route.ownerEpoch,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    } as DurableJob;
    const dtmfListeners = new Set<(digit: string) => void>();
    const audioListeners = new Set<(audio: Uint8Array, timestampMs: number) => void>();
    const markListeners = new Set<(name: string) => void>();
    const closeListeners = new Set<(reason: string) => void>();
    const media = {
      identity: {
        sessionId: route.sessionId,
        callSid: route.carrierCallId,
        streamSid: 'MZ-input',
        ownerId: route.workerId,
        ownerEpoch: route.ownerEpoch,
        generation: route.generation,
      },
      sessionId: route.sessionId,
      bufferedBytes: 0,
      sendAudio: async () => undefined,
      sendMark: async (name: string) => {
        queueMicrotask(() => {
          for (const listener of markListeners) listener(name);
        });
      },
      clear: async () => undefined,
      onAudio: (listener: (audio: Uint8Array, timestampMs: number) => void) => {
        audioListeners.add(listener);
        return () => audioListeners.delete(listener);
      },
      onMark: (listener: (name: string) => void) => {
        markListeners.add(listener);
        return () => markListeners.delete(listener);
      },
      onDtmf: (listener: (digit: string) => void) => {
        dtmfListeners.add(listener);
        return () => dtmfListeners.delete(listener);
      },
      onClose: (listener: (reason: string) => void) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close: async (reason: string) => {
        order.push('media.close');
        for (const listener of [...closeListeners]) listener(reason);
      },
    } as unknown as WorkerMediaSession;
    const audit = vi.fn();
    const telemetryClose = vi.fn(async () => undefined);
    const factory = new ProductionVoiceSessionFactory(
      {
        getRelease: async () => release,
        getCall: async () => ({ id: 'call-input', releaseId: release.id, kind: 'live' }),
        operationStore: {},
      } as never,
      { forAgent: () => ({ resolve: vi.fn() }) } as never,
      {
        createSession: async () => ({
          audit,
          providerUsage: vi.fn(),
          adapter: { speech: vi.fn() },
          withOperationStore: (store: unknown) => store,
          close: telemetryClose,
          startStage: () => () => true,
        }),
      } as never,
      undefined,
      undefined,
      { plugins: [], nativeHandlers: {} },
      {} as never,
      30,
      undefined,
      {
        distribution,
        parent,
        carriers: {
          forJob: async () => ({
            carrier: {
              carrierId: 'fixture',
              capabilities: {
                media: {
                  formats: [MULAW_8K],
                  playbackEvidence: 'carrier-played',
                  clearFlushesMarkers: true,
                },
              },
            },
          }),
        } as never,
      },
      async (_job, _route, reason) => {
        order.push(`fence:${reason}`);
      },
    );
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: async () => route,
        get: async () => job,
      } as unknown as DurableJobStore,
      factory,
      async () => {
        order.push('leg.terminated');
      },
    );
    try {
      await (runtime as unknown as { open(media: WorkerMediaSession): Promise<void> }).open(media);
      expect(sttStart).toHaveBeenCalledOnce();
      for (const listener of dtmfListeners) listener('start');
      await vi.waitFor(() =>
        expect(audit).toHaveBeenCalledWith(
          'transcript.agent',
          expect.objectContaining({ state: 'played' }),
        ),
      );
      for (const listener of audioListeners) listener(Uint8Array.of(1), 20);
      await vi.waitFor(() =>
        expect(telemetryClose).toHaveBeenCalledWith('ended', 'behavior_completed'),
      );
      expect(finish).toHaveBeenCalledOnce();
      expect(order).toContain('fence:behavior_completed');
      expect(order).toContain('media.close');
      expect(order.indexOf('fence:behavior_completed')).toBeLessThan(order.indexOf('media.close'));
      await vi.waitFor(() => expect(order).toContain('leg.terminated'));
    } finally {
      await parent.dispose();
    }
  });
});
