import { createHmac } from 'node:crypto';
import { AgentConfig, MULAW_8K } from '@winsendotai/ovo-contracts';
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

it('isolates a failed open, then accepts production audio despite extra create awaits', async () => {
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
    carrierId: 'twilio',
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
            carrierId: 'twilio',
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
  const path = '/twilio/media?edge=loopback';
  const gateway = new MediaGateway(
    {
      authenticateSessionRoute: async (id: string, token: string) =>
        id === route.sessionId && token === 'route-token'
          ? (route as DurableMediaRoute)
          : id === badRoute.sessionId && token === 'route-token-bad'
            ? (badRoute as DurableMediaRoute)
            : undefined,
      resolveSessionRoute: async ({ carrierCallId }: { carrierCallId: string }) =>
        carrierCallId === route.carrierCallId
          ? (route as DurableMediaRoute)
          : carrierCallId === badRoute.carrierCallId
            ? (badRoute as DurableMediaRoute)
            : undefined,
    },
    {
      publicBaseUrl: publicBase,
      twilioAuthToken: 'twilio-test-token',
      workerToken: 'worker-token',
    },
  );
  const { port } = await gateway.listen();
  const runtime = new WorkerMediaRuntime(
    { url: `ws://127.0.0.1:${port}/worker`, workerId: route.workerId, token: 'worker-token' },
    {
      resolveSessionRoute: async ({ carrierCallId }: { carrierCallId: string }) =>
        carrierCallId === route.carrierCallId ? route : undefined,
      get: async () => job,
    } as never,
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
    if (typeof data === 'string') {
      try {
        frames.push((JSON.parse(data) as { type?: string }).type ?? 'unknown');
      } catch {
        /* binary frame */
      }
    }
    return originalSend.call(
      this,
      data,
      ...(args as Parameters<typeof originalSend> extends [unknown, ...infer A] ? A : never),
    );
  });
  let carrier: Awaited<ReturnType<typeof connectRaw>> | undefined;
  let badCarrier: Awaited<ReturnType<typeof connectRaw>> | undefined;
  try {
    await runtime.connect();
    const signature = createHmac('sha1', 'twilio-test-token')
      .update(`${publicBase}${path}`)
      .digest('base64');
    badCarrier = await connectRaw(port, path, signature);
    badCarrier.send({
      event: 'start',
      sequenceNumber: '1',
      streamSid: 'MZ-bad',
      start: {
        accountSid: 'AC1',
        callSid: badRoute.carrierCallId,
        customParameters: { sessionId: badRoute.sessionId, routeToken: 'route-token-bad' },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: '8000', channels: '1' },
      },
    });
    await vi.waitFor(() => expect(badCarrier!.closed).toBe(true));
    expect(frames).not.toContain('session.accept');
    carrier = await connectRaw(port, path, signature);
    carrier.send({
      event: 'start',
      sequenceNumber: '1',
      streamSid: 'MZ-real-gateway',
      start: {
        accountSid: 'AC1',
        callSid: route.carrierCallId,
        customParameters: { sessionId: route.sessionId, routeToken: 'route-token' },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: '8000', channels: '1' },
      },
    });
    await vi.waitFor(() =>
      expect(carrier!.messages.some((raw) => JSON.parse(raw).event === 'mark')).toBe(true),
    );
    expect(carrier.messages.some((raw) => JSON.parse(raw).event === 'media')).toBe(true);
    expect(frames.indexOf('session.accept')).toBeGreaterThanOrEqual(0);
    expect(frames.indexOf('session.accept')).toBeLessThan(frames.indexOf('media.audio'));
    expect(frames.indexOf('media.audio')).toBeLessThan(frames.indexOf('media.mark'));
  } finally {
    badCarrier?.close();
    carrier?.close();
    sendSpy.mockRestore();
    await runtime.close();
    await gateway.close();
    await parent.dispose();
  }
});
