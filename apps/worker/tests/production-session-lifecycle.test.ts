import { Cap, MULAW_8K, type EndReason, type MediaDuplex } from '@winsendotai/ovo-contracts';
import { FIRST_PARTY, loadDistribution } from '@winsendotai/ovo-distribution';
import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { WorkerMediaSession } from '@winsendotai/ovo-plugin-media';
import { LiveRecordingCapture } from '@winsendotai/ovo-plugin-recordings';
import { AgentConfig, outcomeFor } from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { WorkerMediaRuntime } from '../src/media-runtime.ts';
import { ProductionVoiceSessionFactory } from '../src/production-session-factory.ts';

describe('production session lifecycle from a loaded distribution', () => {
  it('fences before an engine completion closes media and records a completed outcome', async () => {
    const order: string[] = [];
    const audit = vi.fn();
    const telemetryClose = vi.fn(async () => undefined);
    const captureStart = vi.spyOn(LiveRecordingCapture, 'start');
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
          formats: [MULAW_8K],
          consumesTurnDetector: false,
        },
        runtime: { egressHosts: [], modelLicences: [] },
        conformance: ['engine@1'],
      },
      (ctx) => {
        const media = ctx.get(Cap.media) as MediaDuplex;
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
      recording: false,
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
    const closeListeners = new Set<(reason: string) => void>();
    const media = {
      identity: {
        sessionId: route.sessionId,
        callSid: route.carrierCallId,
        streamSid: 'MZ1',
        ownerId: route.workerId,
        ownerEpoch: route.ownerEpoch,
        generation: route.generation,
      },
      sessionId: route.sessionId,
      bufferedBytes: 0,
      sendAudio: async () => undefined,
      sendMark: async () => undefined,
      clear: async () => undefined,
      onAudio: () => () => undefined,
      onMark: () => () => undefined,
      onDtmf: () => () => undefined,
      onClose: (listener: (reason: string) => void) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close: async (reason: string) => {
        order.push('media.close');
        for (const listener of [...closeListeners]) listener(reason);
      },
    } as unknown as WorkerMediaSession;
    const carrierLookup = vi.fn(async () => ({
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
    }));
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
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: async () => route,
        get: async () => job,
      } as unknown as DurableJobStore,
      factory,
      async () => {
        order.push('session.close');
      },
    );
    try {
      await (runtime as unknown as { open(media: WorkerMediaSession): Promise<void> }).open(media);
      expect(carrierLookup).toHaveBeenCalledWith(job, false);
      await complete('behavior_completed');
      await vi.waitFor(() =>
        expect(audit).toHaveBeenCalledWith('session.outcome', {
          outcome: 'completed',
          reason: 'behavior_completed',
        }),
      );
      expect(order).toContain('fence:behavior_completed');
      expect(order).toContain('media.close');
      expect(order.indexOf('fence:behavior_completed')).toBeLessThan(order.indexOf('media.close'));
      await vi.waitFor(() =>
        expect(telemetryClose).toHaveBeenCalledWith('ended', 'behavior_completed'),
      );
      expect(captureStart).not.toHaveBeenCalled();
    } finally {
      captureStart.mockRestore();
      await parent.dispose();
    }
  });
});
