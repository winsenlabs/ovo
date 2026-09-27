import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import {
  fixtureCarrierIngress,
  fixtureSignature,
  fixtureInboundFrame,
} from '../../../packages/conformance/src/drivers/fixture-carrier.ts';
import { routeStore } from '../../../packages/plugin-media/tests/worker-session-fixture.ts';
import { AgentConfig, MULAW_8K, type CarrierHostPorts } from '@winsendotai/ovo-contracts';
import { FIRST_PARTY, loadDistribution } from '@winsendotai/ovo-distribution';
import { MediaGateway, type DurableMediaRoute } from '@winsendotai/ovo-plugin-media';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { compose } from '@winsendotai/ovo-runtime';
import { expect, it, vi } from 'vitest';
import { connectRaw } from '../../../packages/plugin-media/tests/gateway-socket-fixture.ts';
import { selectedSpeechFixture } from '../../api/tests/selected-speech-fixture.ts';
import { WorkerMediaRuntime } from '../src/media-runtime.ts';
import { ProductionVoiceSessionFactory } from '../src/production-session-factory.ts';

it('isolates a failed open, then accepts non-Twilio production audio despite extra create awaits', async () => {
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
        package: '@fixture/real-gateway-tts',
        roles: ['session'],
        load: async () => ({ plugins: [selectedSpeechFixture] }),
      },
    ],
  });
  const parent = await compose([], []);
  const config = AgentConfig.parse({
    name: 'First call',
    mode: 'announcement',
    message: 'Hello.',
    recording: false,
    voice: {
      engine: { plugin: '@winsendotai/ovo-plugin-voice-session-engine', config: {} },
      tts: { plugin: selectedSpeechFixture.manifest.id, binding: 'env', config: {} },
    },
  });
  const release = {
    id: 'release-real-gateway',
    workspaceId: 'workspace-real-gateway',
    agentId: 'agent-real-gateway',
    config,
    plugins: [{ id: '@winsendotai/ovo-behavior-announcement', version: '0.1.0' }],
    selections: {
      engine: {
        pluginId: '@winsendotai/ovo-plugin-voice-session-engine',
        version: '0.1.0',
        config: {},
      },
      tts: {
        pluginId: selectedSpeechFixture.manifest.id,
        version: '1.0.0',
        bindingId: 'env',
        config: {},
      },
    },
    providerBindings: {},
    mcpTools: {},
    draftVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'operator',
  } as ReleaseRecord;
  const route = {
    sessionId: 'session-real-gateway',
    jobId: 'job-real-gateway',
    organizationId: release.workspaceId,
    workerId: 'worker-1',
    workerEndpoint: 'ws://worker-1/internal/media',
    ownerEpoch: 3,
    generation: 2,
    dialRequestId: 'job-real-gateway:3',
    carrierCallId: 'CA-real-gateway',
    carrierId: 'plivo',
    status: 'accepted',
    handshakeExpiresAt: new Date(Date.now() + 60_000),
  } as SessionRoute;
  const badRoute = {
    ...route,
    sessionId: 'session-bad',
    carrierCallId: 'CA-bad',
  } as SessionRoute;
  const job = {
    id: route.jobId,
    workspaceId: release.workspaceId,
    idempotencyKey: route.jobId,
    payload: { releaseId: release.id, callId: 'call-real-gateway' },
    status: 'accepted',
    ownerId: route.workerId,
    ownerEpoch: route.ownerEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  } as DurableJob;
  const factory = new ProductionVoiceSessionFactory(
    {
      getRelease: async () => release,
      getCall: async () => ({ id: 'call-real-gateway', releaseId: release.id, kind: 'live' }),
      operationStore: {},
    } as never,
    { forAgent: () => ({ resolve: vi.fn() }) } as never,
    {
      createSession: async () => ({
        audit: vi.fn(),
        providerUsage: vi.fn(),
        adapter: { speech: vi.fn() },
        withOperationStore: (store: unknown) => store,
        close: vi.fn(async () => undefined),
        startStage: () => () => true,
      }),
    } as never,
    undefined,
    undefined,
    { plugins: [], nativeHandlers: {} },
    undefined,
    30,
    undefined,
    {
      distribution,
      parent,
      carriers: {
        forJob: async () => ({
          carrier: {
            carrierId: 'plivo',
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
  );
  const publicBase = 'https://voice.example.test';
  const path = '/carriers/plivo/env/media';
  const health = createServer((_request, response) => response.writeHead(404).end());
  health.listen(0, '127.0.0.1');
  await once(health, 'listening');
  const address = health.address();
  if (!address || typeof address === 'string') throw new Error('worker test port unavailable');
  route.workerEndpoint = `ws://127.0.0.1:${address.port}/internal/media`;
  badRoute.workerEndpoint = route.workerEndpoint;
  const baseIngress = fixtureCarrierIngress();
  const gateway = new MediaGateway(
    {
      authenticateSessionRoute: async (id, token) =>
        id === route.sessionId && token === 'route-fixture-token'
          ? (route as DurableMediaRoute)
          : id === badRoute.sessionId && token === 'bad-token'
            ? (badRoute as DurableMediaRoute)
            : undefined,
      resolveSessionRoute: async ({ carrierCallId }) =>
        carrierCallId === route.carrierCallId
          ? (route as DurableMediaRoute)
          : (badRoute as DurableMediaRoute),
      bindCarrierCallId: async () => ({ kind: 'unmatched' }),
      recordCarrierCallIdMismatch: async () => undefined,
    },
    {
      publicBaseUrl: publicBase,
      workerToken: 'worker-token',
      ingresses: [
        {
          ...baseIngress,
          carrierId: 'plivo',
          capabilities: { ...baseIngress.capabilities, carrierId: 'plivo' },
        },
      ],
      hostFor: () =>
        ({
          resolveBinding: async () => ({
            bindingId: 'env',
            pluginId: 'fixture',
            workspaceId: release.workspaceId,
            config: {},
            secret: 'fixture-secret',
          }),
          verifyUrlSecret: () => true,
        }) as unknown as CarrierHostPorts,
    },
  );
  const { port } = await gateway.listen();
  const store = routeStore(route, job);
  const runtime = new WorkerMediaRuntime(
    { httpServer: health, workerId: route.workerId, token: 'worker-token' },
    store as never,
    {
      create: async (input) => {
        const result = await factory.create(input);
        for (let hop = 0; hop < 4; hop++) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return result;
      },
    },
  );
  const frames: string[] = [];
  const originalSend = WebSocket.prototype.send;
  const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
    this: WebSocket,
    data,
    ...args
  ) {
    if (typeof data === 'string')
      frames.push((JSON.parse(data) as { type?: string }).type ?? 'carrier');
    return originalSend.call(
      this,
      data,
      ...(args as Parameters<typeof originalSend> extends [unknown, ...infer A] ? A : never),
    );
  });
  let carrier: Awaited<ReturnType<typeof connectRaw>> | undefined;
  let badCarrier: Awaited<ReturnType<typeof connectRaw>> | undefined;
  try {
    await runtime.start();
    const signature = fixtureSignature(
      'fixture-secret',
      'wss://voice.example.test/carriers/plivo/env/media',
    );
    const start = (selected: SessionRoute, rt: string) =>
      fixtureInboundFrame({
        type: 'start',
        carrierCallId: selected.carrierCallId!,
        streamId: `stream-${selected.sessionId}`,
        format: MULAW_8K,
        routeParams: { sid: selected.sessionId, rt },
      });
    badCarrier = await connectRaw(port, path, signature);
    badCarrier.send(start(badRoute, 'bad-token'));
    await vi.waitFor(() => expect(badCarrier!.closed).toBe(true));
    expect(frames).not.toContain('session.accept');
    carrier = await connectRaw(port, path, signature);
    carrier.send(start(route, 'route-fixture-token'));
    await vi.waitFor(() =>
      expect(carrier!.messages.some((raw) => JSON.parse(raw).event === 'mark')).toBe(true),
    );
    expect(carrier.messages.some((raw) => JSON.parse(raw).event === 'media')).toBe(true);
    expect(frames.indexOf('session.accept')).toBeGreaterThanOrEqual(0);
    expect(frames.indexOf('session.accept')).toBeLessThan(frames.indexOf('audio'));
    expect(frames.indexOf('audio')).toBeLessThan(frames.indexOf('mark'));
    await vi.waitFor(() =>
      expect(store.queries.some((sql) => sql.includes('INSERT INTO ovo_carrier_callbacks'))).toBe(
        true,
      ),
    );
  } finally {
    badCarrier?.close();
    carrier?.close();
    sendSpy.mockRestore();
    await runtime.close();
    await gateway.close();
    health.closeAllConnections();
    await new Promise<void>((resolve) => health.close(() => resolve()));
    await parent.dispose();
  }
});
