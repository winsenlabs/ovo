import { Cap, MULAW_8K, type EndReason, type MediaDuplex } from '@winsendotai/ovo-contracts';
import { AgentConfig, outcomeFor } from '@winsendotai/ovo-contracts';
import { FIRST_PARTY, loadDistribution } from '@winsendotai/ovo-distribution';
import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { expect, vi } from 'vitest';
import { workerSessionFixture } from '../../../packages/plugin-media/tests/worker-session-fixture.ts';
import { WorkerMediaRuntime } from '../src/media-runtime.ts';
import { ProductionVoiceSessionFactory } from '../src/production-session-factory.ts';

export const WORKSPACE = 'workspace-1';
export const CALL = 'call-1';
/** One 20 ms carrier frame of 8 kHz mu-law. */
export const FRAME_BYTES = 160;

/**
 * A live call through the production worker path, the way a Twilio call reaches it: the gateway
 * socket, `WorkerMediaRuntime`, `ProductionVoiceSessionFactory` and the release's own
 * `recording` flag. Only the engine is a fixture: it hands the test the media the real voice
 * engine would get, so the test plays the agent's audio and hears the caller's through it.
 */
export async function recordedCall(input: {
  recording: boolean;
  recordings?: LiveRecordingService;
  retentionDays?: number;
  agentRetentionDays?: number;
}) {
  const audits: Array<[string, Record<string, unknown>]> = [];
  const heard: Uint8Array[] = [];
  let media!: MediaDuplex;
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
      media = ctx.get(Cap.media) as MediaDuplex;
      media.onAudio((bytes) => heard.push(Uint8Array.from(bytes)));
      ctx.provide(Cap.engine, {
        start: async () => undefined,
        dispose: async (reason: EndReason) => ({ reason, outcome: outcomeFor(reason) }),
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
      { package: '@fixture/engine', roles: ['session'], load: async () => ({ plugins: [engine] }) },
    ],
  });
  const parent = await compose([], []);
  const release = {
    id: 'release-1',
    workspaceId: WORKSPACE,
    agentId: 'agent-1',
    config: AgentConfig.parse({
      name: 'Recorded',
      mode: 'announcement',
      message: 'Done',
      recording: input.recording,
      ...(input.agentRetentionDays ? { recordingRetentionDays: input.agentRetentionDays } : {}),
    }),
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
    organizationId: WORKSPACE,
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
    workspaceId: WORKSPACE,
    idempotencyKey: 'job-1',
    payload: { releaseId: release.id, callId: CALL },
    status: 'accepted',
    ownerId: 'worker-1',
    ownerEpoch: 7,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  } as DurableJob;
  const carrier = {
    carrierId: 'fixture',
    capabilities: {
      media: { formats: [MULAW_8K], playbackEvidence: 'carrier-played', clearFlushesMarkers: true },
    },
  };
  const factory = new ProductionVoiceSessionFactory(
    {
      getRelease: async () => release,
      getCall: async () => ({ id: CALL, releaseId: release.id, kind: 'live' }),
      operationStore: {},
    } as never,
    { forAgent: () => ({ resolve: vi.fn() }) } as never,
    {
      createSession: async () => ({
        audit: (type: string, payload: Record<string, unknown>) => audits.push([type, payload]),
        providerUsage: vi.fn(),
        adapter: { speech: vi.fn() },
        withOperationStore: (store: unknown) => store,
        close: async () => undefined,
      }),
    } as never,
    undefined,
    undefined,
    { plugins: [], nativeHandlers: {} },
    input.recordings,
    input.retentionDays ?? 30,
    undefined,
    { distribution, parent, carriers: { forJob: async () => ({ carrier }) } as never },
  );
  const create = vi.spyOn(factory, 'create');
  const closed = vi.fn();
  const transport = await workerSessionFixture(
    route,
    job,
    (httpServer, store) =>
      new WorkerMediaRuntime(
        { httpServer, workerId: route.workerId, token: 'worker-fixture-token' },
        store as unknown as DurableJobStore,
        factory,
        async () => closed(),
      ),
  );
  let sequenceNumber = 0;
  return {
    audits,
    heard,
    transport,
    /** The session is composed: the engine has its media. */
    composed: () =>
      vi.waitFor(async () => {
        const created = create.mock.results[0];
        if (!created) throw new Error('the session is not created yet');
        await created.value;
      }),
    /** The caller says `bytes`, in carrier frames stamped as the carrier stamps them. */
    caller(bytes: Uint8Array) {
      for (let at = 0; at < bytes.length; at += FRAME_BYTES) {
        transport.send({
          type: 'media.audio',
          payload: Buffer.from(bytes.subarray(at, at + FRAME_BYTES)).toString('base64'),
          sequenceNumber: ++sequenceNumber,
          timestampMs: sequenceNumber * 20,
        });
      }
    },
    /** The agent plays `bytes` to the caller. */
    agent: (bytes: Uint8Array) => media.sendAudio(bytes),
    /** The agent ends the call, and the worker finishes tearing it down. */
    async hangUp() {
      await media.close('behavior_completed');
      await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    },
    close: async () => {
      await transport.close();
      await parent.dispose();
    },
  };
}
