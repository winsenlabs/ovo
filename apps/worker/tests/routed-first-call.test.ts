import { AgentConfig, Cap, MULAW_8K, type EndReason } from '@winsendotai/ovo-contracts';
import { FIRST_PARTY, loadDistribution } from '@winsendotai/ovo-distribution';
import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import { createRouterBehaviorPlugin } from '@winsendotai/ovo-plugin-router';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { MemoryCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { expect, it, vi } from 'vitest';
import {
  POINT_ID,
  ROUTER_RELEASE,
  SALES_EN_RELEASE,
  POOL_SALES,
  snapshot,
} from '../../../packages/contracts/tests/routing-fixture.ts';
import { workerSessionFixture } from '../../../packages/plugin-media/tests/worker-session-fixture.ts';
import { WorkerMediaRuntime } from '../src/media-runtime.ts';
import { RoutedVoiceSessionFactory } from '../src/routed-session-factory.ts';

const ROUTING_RELEASE = '99999999-9999-4999-8999-999999999999';
const DEFAULT_RELEASE = '55555555-5555-4555-8555-555555555555';
const SPEECH = { languages: ['*'], interim: false, wordTimestamps: false, forceEndpoint: false };

/** STT that hears nothing: this caller only presses keys. */
const stt = definePlugin(
  {
    id: '@fixture/routed-stt',
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
    capabilities: { ...SPEECH, inputFormats: [MULAW_8K], turnSignals: ['end-of-turn'] },
    meters: [{ key: 'fixture.stt.audio', unit: 'audio_seconds', label: 'Audio', role: 'stt' }],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['stt@1'],
  },
  (ctx) => {
    ctx.provide(Cap.stt, {
      capabilities: { ...SPEECH, inputFormats: [MULAW_8K], turnSignals: ['end-of-turn'] },
      start: async () => ({
        write: async () => undefined,
        finish: async () => undefined,
        cancel: async () => undefined,
      }),
    });
  },
);

/** TTS whose audio is the text itself, so the gateway's frames say who spoke. */
const tts = definePlugin(
  {
    id: '@fixture/routed-tts',
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
    capabilities: { ...SPEECH, outputFormats: [MULAW_8K], turnSignals: [] },
    meters: [{ key: 'fixture.tts.text', unit: 'characters', label: 'Text', role: 'tts' }],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['tts@1'],
  },
  (ctx) => {
    ctx.provide(Cap.tts, {
      capabilities: { ...SPEECH, outputFormats: [MULAW_8K], turnSignals: [] },
      cacheIdentity: () => ({ provider: 'fixture', model: 'fixture', voice: '', revision: '1' }),
      async *synthesize(input: { text: string }) {
        yield new TextEncoder().encode(`<${input.text}>`);
      },
    });
  },
);

function release(id: string, agentId: string, config: Record<string, unknown>, behavior: string) {
  const speech = (plugin: { manifest: { id: string } }) => ({
    plugin: plugin.manifest.id,
    binding: 'env',
    config: {},
  });
  const selection = (plugin: { manifest: { id: string; version: string } }) => ({
    pluginId: plugin.manifest.id,
    version: plugin.manifest.version,
    bindingId: 'env',
    config: {},
  });
  const input = config.mode !== 'announcement';
  return {
    id,
    workspaceId: 'workspace-1',
    agentId,
    config: AgentConfig.parse({
      ...config,
      recording: false,
      voice: {
        engine: { plugin: '@winsendotai/ovo-plugin-voice-session-engine', config: {} },
        ...(input ? { stt: speech(stt) } : {}),
        tts: speech(tts),
      },
    }),
    plugins: [{ id: behavior, version: '0.1.0' }],
    selections: {
      engine: {
        pluginId: '@winsendotai/ovo-plugin-voice-session-engine',
        version: '0.1.0',
        config: {},
      },
      ...(input ? { stt: selection(stt) } : {}),
      tts: selection(tts),
    },
    providerBindings: {},
    mcpTools: {},
    draftVersion: 1,
    createdAt: '2026-10-15T00:00:00.000Z',
    createdBy: 'operator-1',
  } as ReleaseRecord;
}

it('routes a keypad caller to an announcement agent on the same media link (Wave 15 R1)', async () => {
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
        package: '@fixture/routed-stt',
        roles: ['session'],
        load: async () => ({ plugins: [stt] }),
      },
      {
        package: '@fixture/routed-tts',
        roles: ['session'],
        load: async () => ({ plugins: [tts] }),
      },
    ],
  });
  const parent = await compose([], []);
  // The router's own FAQ behaviour never runs: the router replaces it.
  const router = release(
    ROUTER_RELEASE,
    'front-desk',
    { name: 'Front desk', mode: 'faq', faq: [] },
    '@winsendotai/ovo-behavior-faq',
  );
  const agent = release(
    SALES_EN_RELEASE,
    'sales-en',
    { name: 'Sales', mode: 'announcement', message: 'Sales here.' },
    '@winsendotai/ovo-behavior-announcement',
  );
  const releases = [router, agent];
  const route = {
    sessionId: 'session-routed',
    jobId: 'job-routed',
    organizationId: 'workspace-1',
    workerId: 'worker-1',
    workerEndpoint: 'ws://worker-1/internal/media',
    ownerEpoch: 7,
    generation: 2,
    dialRequestId: 'job-routed:7',
    carrierCallId: 'CA-routed',
    carrierId: 'fixture',
    status: 'accepted',
    handshakeExpiresAt: new Date(Date.now() + 60_000),
  } as SessionRoute;
  const job = {
    id: 'job-routed',
    workspaceId: 'workspace-1',
    idempotencyKey: 'job-routed',
    payload: {
      kind: 'inbound_call',
      releaseId: ROUTER_RELEASE,
      callId: 'call-routed',
      from: '+919800000001',
      to: '+918000000002',
      routing: {
        routingReleaseId: ROUTING_RELEASE,
        routingPointId: POINT_ID,
        version: 1,
        defaultReleaseId: DEFAULT_RELEASE,
      },
    },
    status: 'accepted',
    ownerId: route.workerId,
    ownerEpoch: route.ownerEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  } as DurableJob;
  const outcomes = new MemoryCallOutcomeStore();
  const audits: string[] = [];
  const telemetryClose = vi.fn(async () => undefined);
  const hangups: { releaseId: unknown; reason: EndReason }[] = [];
  const claims = {
    claim: vi.fn(async ({ tiers }: { tiers: readonly (readonly { memberId: string }[])[] }) => ({
      kind: 'claimed' as const,
      claimId: '00000000-0000-4000-8000-000000000001',
      candidate: tiers[0]![0]!,
    })),
    release: vi.fn(async () => 1),
  };
  const factory = new RoutedVoiceSessionFactory(
    {
      getRelease: async (_workspace: string, id: string) => releases.find((item) => item.id === id),
      getCall: async () => undefined,
      createCall: async (call: Record<string, unknown>) => ({ ...call, kind: 'live' }),
      operationStore: {},
    } as never,
    { forAgent: () => ({ resolve: vi.fn() }) } as never,
    {
      createSession: async () => ({
        audit: (type: string) => audits.push(type),
        providerUsage: vi.fn(),
        adapter: { speech: vi.fn(), timing: vi.fn() },
        withOperationStore: (store: unknown) => store,
        close: telemetryClose,
        startStage: () => () => true,
      }),
      strictestTranscriptText: () => 'store',
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
      outcomes,
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
    async (closing, _route, reason) => {
      hangups.push({ releaseId: closing.payload.releaseId, reason });
    },
  ).route({
    routing: {
      releases: {
        get: async () => ({ id: ROUTING_RELEASE, routingPointId: POINT_ID, snapshot: snapshot() }),
      } as never,
      claims: claims as never,
    },
    routerBehavior: createRouterBehaviorPlugin,
    externalEnabled: false,
  });
  const frames: string[] = [];
  const transport = await workerSessionFixture(
    route,
    job,
    (httpServer, store) =>
      new WorkerMediaRuntime(
        { httpServer, workerId: route.workerId, token: 'worker-fixture-token' },
        store as unknown as DurableJobStore,
        factory,
      ),
    (frame) => {
      if (frame.type === 'audio') frames.push(Buffer.from(frame.payload, 'base64').toString());
      if (frame.type === 'session.end') frames.push('session.end');
    },
  );
  try {
    // The router greets the caller.
    await vi.waitFor(() => expect(frames.join('')).toContain('<Welcome to Acme.'));
    transport.send({ type: 'media.dtmf', digit: '1' });
    transport.send({ type: 'media.dtmf', digit: '#' });
    // The announcement agent speaks on the same link, then the call ends once.
    await vi.waitFor(() => expect(frames).toContain('session.end'), { timeout: 10_000 });
    const spoken = frames.join('');
    expect(spoken.indexOf('<Sales here.>')).toBeGreaterThan(spoken.indexOf('<Welcome to Acme.'));
    expect(frames.filter((frame) => frame === 'session.end')).toHaveLength(1);
    expect(frames.at(-1)).toBe('session.end');
    expect(hangups).toEqual([{ releaseId: SALES_EN_RELEASE, reason: 'behavior_completed' }]);
    await vi.waitFor(() => expect(telemetryClose).toHaveBeenCalledWith('behavior_completed'));
    const events = (await outcomes.listEvents('workspace-1', 'call-routed')).items;
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['route.segment', 'route.node', 'route.decision', 'call.outcome']),
    );
    expect(
      events.filter((event) => event.type === 'route.segment').map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ index: 0, role: 'router', releaseId: ROUTER_RELEASE }),
      expect.objectContaining({
        index: 1,
        role: 'agent',
        reason: 'route',
        releaseId: SALES_EN_RELEASE,
        poolId: POOL_SALES,
      }),
    ]);
    expect(events.find((event) => event.type === 'route.decision')?.payload).toMatchObject({
      target: 'agent',
      releaseId: SALES_EN_RELEASE,
      path: ['intent'],
    });
    expect(audits).toEqual(
      expect.arrayContaining(['route.decision', 'route.segment', 'route.handoff.prepared']),
    );
    expect(claims.claim).toHaveBeenCalledOnce();
    expect(claims.release).toHaveBeenCalledWith('job-routed');
  } finally {
    await transport.close();
    await parent.dispose();
  }
});
