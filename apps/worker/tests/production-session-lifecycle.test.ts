import {
  Cap,
  MULAW_8K,
  PCM16_16K,
  sameFormat,
  type AudioFormat,
  type EndReason,
  type MediaDuplex,
} from '@winsendotai/ovo-contracts';
import { FIRST_PARTY, loadDistribution } from '@winsendotai/ovo-distribution';
import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { workerSessionFixture } from '../../../packages/plugin-media/tests/worker-session-fixture.ts';
import { LiveRecordingCapture } from '@winsendotai/ovo-plugin-recordings';
import { AgentConfig, outcomeFor } from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { WorkerMediaRuntime } from '../src/media-runtime.ts';
import { ProductionVoiceSessionFactory } from '../src/production-session-factory.ts';

describe('production session lifecycle from a loaded distribution', () => {
  it.each([
    { name: 'μ-law with recording disabled', format: MULAW_8K, recording: false },
    {
      name: 'selected PCM16-only carrier with recording enabled',
      format: PCM16_16K,
      recording: true,
    },
    {
      name: 'unsupported negotiated PCM16 format',
      format: PCM16_16K,
      recording: false,
      unsupported: true,
    },
  ])('fences completion and composes $name', async ({ format, recording, unsupported }) => {
    const order: string[] = [];
    const audit = vi.fn();
    const telemetryClose = vi.fn(async () => undefined);
    const captureStart = vi.spyOn(LiveRecordingCapture, 'start');
    let composedFormat: AudioFormat | undefined;
    let complete!: (reason: EndReason) => Promise<void>;
    const engine = definePlugin(
      {
        id: '@fixture/engine',
        version: '1.2.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'engine',
        provider: 'fixture',
        provides: [`${Cap.engine}@2`],
        requires: [Cap.behavior, Cap.media],
        configSchema: { type: 'object' },
        secretFields: [],
        capabilities: {
          turnDetection: ['provider'],
          bargeIn: true,
          dtmf: true,
          confirmedPlayback: true,
          ownsProviders: false,
          formats: [MULAW_8K, PCM16_16K],
          consumesTurnDetector: false,
        },
        runtime: { egressHosts: [], modelLicences: [] },
        conformance: ['engine@1'],
      },
      (ctx) => {
        const media = ctx.get(Cap.media) as MediaDuplex;
        composedFormat = media.format;
        complete = (reason) => media.close(reason);
        ctx.provide(Cap.engine, {
          start: async () => undefined,
          dispose: async (reason: EndReason) => {
            order.push('engine.dispose');
            return { reason, outcome: outcomeFor(reason) };
          },
          ended: Promise.resolve({ reason: 'behavior_completed', outcome: 'completed' }),
          subscribe: () => () => undefined,
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
          package: '@fixture/engine',
          roles: ['session'],
          load: async () => ({ plugins: [engine] }),
        },
      ],
    });
    const parent = await compose([], []);
    const config = AgentConfig.parse({
      name: 'Lifecycle',
      mode: 'announcement',
      message: 'Done',
      recording,
    });
    const release = {
      id: 'release-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      config,
      plugins: [{ id: '@winsendotai/ovo-behavior-announcement', version: '0.1.0' }],
      selections: {
        engine: { pluginId: engine.manifest.id, version: engine.manifest.version, config: {} },
      },
      providerBindings: {},
      mcpTools: {},
      draftVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'operator-1',
    } as ReleaseRecord;
    const route = {
      sessionId: 'session-1',
      jobId: 'job-1',
      organizationId: 'workspace-1',
      workerId: 'worker-1',
      workerEndpoint: 'ws://worker-1/internal/media',
      ownerEpoch: 7,
      generation: 2,
      dialRequestId: 'job-1:7',
      carrierCallId: 'CA1',
      carrierId: 'fixture',
      status: 'accepted',
      handshakeExpiresAt: new Date(Date.now() + 60_000),
    } as SessionRoute;
    const job = {
      id: 'job-1',
      workspaceId: 'workspace-1',
      idempotencyKey: 'job-1',
      payload: { releaseId: 'release-1', callId: 'call-1' },
      status: 'accepted',
      ownerId: 'worker-1',
      ownerEpoch: 7,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    } as DurableJob;
    const carrierLookup = vi.fn(async () => ({
      carrier: {
        carrierId: 'fixture',
        capabilities: {
          media: {
            formats: unsupported ? [MULAW_8K] : [format],
            playbackEvidence: 'carrier-played',
            clearFlushesMarkers: true,
          },
        },
      },
    }));
    if (recording)
      captureStart.mockImplementation(async ({ media }) => {
        const finish = vi.fn(async () => undefined);
        const attachEvidence = vi.fn(() => () => undefined);
        return new Proxy(media, {
          get(target, key) {
            if (key === 'finish') return finish;
            if (key === 'attachEvidence') return attachEvidence;
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as never;
      });
    const factory = new ProductionVoiceSessionFactory(
      {
        getRelease: async () => release,
        getCall: async () => ({ id: 'call-1', releaseId: release.id, kind: 'live' }),
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
        }),
      } as never,
      undefined,
      undefined,
      { plugins: [], nativeHandlers: {} },
      {} as never,
      30,
      undefined,
      { distribution, parent, carriers: { forJob: carrierLookup } as never },
      async (_job, _route, reason) => {
        order.push(`fence:${reason}`);
      },
    );
    const createSession = vi.spyOn(factory, 'create');
    const transport = await workerSessionFixture(
      route,
      job,
      (httpServer, store) =>
        new WorkerMediaRuntime(
          { httpServer, workerId: route.workerId, token: 'worker-fixture-token' },
          store as unknown as DurableJobStore,
          factory,
          async () => {
            order.push('session.close');
          },
        ),
      (frame) => {
        if (frame.type === 'session.end') order.push('media.close');
      },
      format,
    );
    try {
      expect(transport.messages[0]).toEqual({ type: 'session.accept' });
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce());
      if (unsupported) {
        await expect(createSession.mock.results[0]!.value).rejects.toThrow(
          'Selected carrier does not support negotiated worker media format',
        );
        expect(composedFormat).toBeUndefined();
        expect(captureStart).not.toHaveBeenCalled();
        expect(
          transport.store.queries.some((sql) => sql.includes('INSERT INTO ovo_carrier_callbacks')),
        ).toBe(false);
        await vi.waitFor(() => expect(order).toContain('session.close'));
        return;
      }
      await vi.waitFor(() =>
        expect(
          transport.store.queries.some((sql) => sql.includes('INSERT INTO ovo_carrier_callbacks')),
        ).toBe(true),
      );
      expect(carrierLookup).toHaveBeenCalledWith(job, false);
      expect(composedFormat && sameFormat(composedFormat, format)).toBe(true);
      await complete('behavior_completed');
      await vi.waitFor(() =>
        expect(audit).toHaveBeenCalledWith('session.outcome', {
          outcome: 'completed',
          reason: 'behavior_completed',
        }),
      );
      expect(order).toContain('fence:behavior_completed');
      await vi.waitFor(() =>
        expect(transport.messages.some((frame) => frame.type === 'session.end')).toBe(true),
      );
      expect(order).toContain('media.close');
      expect(order.indexOf('fence:behavior_completed')).toBeLessThan(order.indexOf('media.close'));
      expect(order.indexOf('fence:behavior_completed')).toBeLessThan(
        order.indexOf('engine.dispose'),
      );
      await vi.waitFor(() =>
        expect(telemetryClose).toHaveBeenCalledWith('ended', 'behavior_completed'),
      );
      if (recording) {
        expect(captureStart).toHaveBeenCalledOnce();
        expect(captureStart.mock.calls[0]?.[0].media).toBe(createSession.mock.calls[0]?.[0].media);
      } else expect(captureStart).not.toHaveBeenCalled();
    } finally {
      captureStart.mockRestore();
      await transport.close();
      await parent.dispose();
    }
  });
});
