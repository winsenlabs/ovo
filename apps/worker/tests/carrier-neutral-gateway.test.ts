import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import { expect, it, vi } from 'vitest';
import { MULAW_8K, type CarrierHostPorts } from '@winsendotai/ovo-contracts';
import { MediaGateway } from '@winsendotai/ovo-plugin-media';
import { workerSessionFixture } from '../../../packages/plugin-media/tests/worker-session-fixture.ts';
import type { DurableJobStore, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import {
  fixtureCarrierIngress,
  fixtureInboundFrame,
  fixtureSignature,
} from '../../../packages/conformance/src/drivers/fixture-carrier.ts';
import {
  WorkerMediaRuntime,
  type VoiceSessionFactory,
  type ManagedVoiceSession,
} from '../src/media-runtime.ts';

it.skipIf(!process.env.OVO_TEST_POSTGRES_URL)(
  'admits a non-Twilio stream through real durable claims and records media.opened once',
  async () => {
    const url = process.env.OVO_TEST_POSTGRES_URL!;
    const schema = `gateway_worker_${randomUUID().replaceAll('-', '')}`;
    const admin = new PostgresOrchestrationStore({ connectionString: url });
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    const store = new PostgresOrchestrationStore({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    const health = createServer((_request, response) => response.writeHead(404).end());
    health.listen(0, '127.0.0.1');
    await once(health, 'listening');
    const address = health.address();
    if (!address || typeof address === 'string') throw new Error('worker has no loopback port');
    const workerId = 'worker-carrier-neutral';
    const carrierId = 'plivo';
    const token = randomUUID();
    const jobId = randomUUID();
    const sessionId = randomUUID();
    const dispose = vi.fn(async () => undefined);
    const onSessionClose = vi.fn(async () => undefined);
    const factory = vi.fn(async ({ media }: Parameters<VoiceSessionFactory['create']>[0]) => {
      media.onAudio((bytes: Uint8Array) => {
        void media.sendAudio(bytes).then(() => media.sendMark('echo'));
      });
      return { dispose };
    });
    const runtime = new WorkerMediaRuntime(
      { httpServer: health, workerId, token: 'worker-token' },
      store,
      { create: factory },
      onSessionClose,
    );
    let gateway: MediaGateway | undefined;
    const peers: WebSocket[] = [];
    try {
      await store.migrate();
      await store.reportWorker({ workerId, state: 'reserved', ownershipEpoch: 3, leaseMs: 60_000 });
      await store.enqueue({ id: jobId, workspaceId: schema, idempotencyKey: jobId, payload: {} });
      const claimed = await store.claim(jobId, workerId, 60_000);
      if (claimed.kind !== 'execute') throw new Error('job was not admitted');
      const requestId = `${jobId}:${claimed.job.ownerEpoch}`;
      const route = await store.beginDialSession({
        jobId,
        sessionId,
        organizationId: schema,
        workerId,
        workerEndpoint: `ws://127.0.0.1:${address.port}/internal/media`,
        ownerEpoch: claimed.job.ownerEpoch,
        generation: 1,
        dialRequestId: requestId,
        carrierId,
        bindingId: 'env',
        handshakeTokenHash: createHash('sha256').update(token).digest('hex'),
        handshakeExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(route).toBeDefined();
      expect(
        await store.markDialAccepted({
          jobId,
          workerId,
          ownerEpoch: claimed.job.ownerEpoch,
          dialRequestId: requestId,
          carrierCallId: 'call-neutral',
        }),
      ).toBe(true);
      const base = fixtureCarrierIngress();
      gateway = new MediaGateway(
        {
          authenticateSessionRoute: (sid, rt) => store.authenticateSessionRoute(sid, rt),
          resolveSessionRoute: (lookup) =>
            store.resolveSessionRoute({ ...lookup, organizationId: schema, carrierId }),
          bindCarrierCallId: (input) => store.bindCarrierCallId(input),
          recordCarrierCallIdMismatch: (input) => store.recordCarrierCallIdMismatch(input),
        },
        {
          publicBaseUrl: 'https://voice.example.test',
          workerToken: 'worker-token',
          ingresses: [{ ...base, carrierId, capabilities: { ...base.capabilities, carrierId } }],
          hostFor: () =>
            ({
              resolveBinding: async () => ({
                workspaceId: schema,
                bindingId: 'env',
                pluginId: 'fixture',
                config: {},
                secret: 'fixture-secret',
              }),
              verifyUrlSecret: () => true,
            }) as unknown as CarrierHostPorts,
        },
      );
      await runtime.start();
      const { port } = await gateway.listen();
      const connect = async (routeToken: string) => {
        const peer = new WebSocket(`ws://127.0.0.1:${port}/carriers/${carrierId}/env/media`, {
          headers: {
            'x-fixture-signature': fixtureSignature(
              'fixture-secret',
              `wss://voice.example.test/carriers/${carrierId}/env/media`,
            ),
          },
        });
        peers.push(peer);
        await once(peer, 'open');
        peer.send(
          fixtureInboundFrame({
            type: 'start',
            carrierCallId: 'call-neutral',
            streamId: 'stream-neutral',
            format: MULAW_8K,
            routeParams: { sid: sessionId, rt: routeToken },
          }),
        );
        return peer;
      };
      const refused = await connect('wrong-token');
      await vi.waitFor(() => expect(refused.readyState).toBe(WebSocket.CLOSED));
      expect(factory).not.toHaveBeenCalled();
      const carrier = await connect(token);
      const output: Record<string, unknown>[] = [];
      carrier.on('message', (raw) => output.push(JSON.parse(raw.toString())));
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
      expect(factory.mock.calls[0]?.[0].route.carrierId).toBe(carrierId);
      await vi.waitFor(async () => {
        const rows = await store.pool.query(
          "SELECT status FROM ovo_carrier_callbacks WHERE session_id=$1 AND provider='ovo.media'",
          [sessionId],
        );
        expect(rows.rows).toEqual([{ status: 'session_opened' }]);
      });
      const durable = await store.pool.query(
        'SELECT handshake_claimed_at FROM ovo_session_routes WHERE session_id=$1',
        [sessionId],
      );
      expect(durable.rows[0].handshake_claimed_at).toBeInstanceOf(Date);
      carrier.send(
        fixtureInboundFrame({
          type: 'audio',
          seq: 1,
          timestampMs: 20,
          payload: Uint8Array.of(7, 8),
        }),
      );
      await vi.waitFor(() =>
        expect(output).toContainEqual(
          expect.objectContaining({ event: 'media', media: { payload: 'Bwg=' } }),
        ),
      );
      // A malformed unauthenticated peer must not affect this healthy admitted session.
      const direct = new WebSocket(`ws://127.0.0.1:${address.port}/internal/media`, {
        headers: { authorization: 'Bearer worker-token' },
      });
      peers.push(direct);
      await once(direct, 'open');
      direct.send(Buffer.alloc(1_048_577));
      await vi.waitFor(() => expect(direct.readyState).toBe(WebSocket.CLOSED));
      expect(onSessionClose).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      for (const peer of peers) peer.terminate();
      await gateway?.close();
      health.closeAllConnections();
      await new Promise<void>((resolve) => health.close(() => resolve()));
      await store.close();
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    }
  },
);

it('finalizes an admitted worker session once when ws rejects an oversized active frame', async () => {
  const route: SessionRoute = {
    sessionId: 'session-errors',
    jobId: 'job-errors',
    organizationId: 'workspace-errors',
    workerId: 'worker-errors',
    workerEndpoint: 'ws://fixture/internal/media',
    ownerEpoch: 7,
    generation: 1,
    dialRequestId: 'job-errors:7',
    carrierId: 'plivo',
    bindingId: undefined,
    carrierCallId: 'call-errors',
    status: 'accepted',
    handshakeExpiresAt: new Date(Date.now() + 60_000),
  };
  const job = {
    id: route.jobId,
    workspaceId: route.organizationId,
    idempotencyKey: route.jobId,
    payload: {},
    status: 'accepted',
    ownerId: route.workerId,
    ownerEpoch: route.ownerEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  const dispose = vi.fn(async () => undefined);
  const onSessionClose = vi.fn(async () => undefined);
  const fixture = await workerSessionFixture(
    route,
    job,
    (httpServer, store) =>
      new WorkerMediaRuntime(
        { httpServer, workerId: route.workerId, token: 'worker-fixture-token' },
        store as unknown as DurableJobStore,
        { create: async () => ({ dispose }) },
        onSessionClose,
      ),
  );
  try {
    await vi.waitFor(() =>
      expect(
        fixture.store.queries.some((sql) => sql.includes('INSERT INTO ovo_carrier_callbacks')),
      ).toBe(true),
    );
    fixture.sendRaw(Buffer.alloc(1_048_577));
    await vi.waitFor(() =>
      expect(onSessionClose).toHaveBeenCalledWith(route, 'error:media-transport'),
    );
    expect(onSessionClose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledExactlyOnceWith('error:media-transport', false);
  } finally {
    await fixture.close();
  }
});

it('finalizes an explicit gateway close while engine startup is still pending', async () => {
  const route = {
    sessionId: 'session-close-probe',
    jobId: 'job-close-probe',
    organizationId: 'workspace',
    workerId: 'worker',
    ownerEpoch: 7,
    generation: 2,
    carrierId: 'fixture',
    carrierCallId: 'call-close-probe',
    bindingId: 'env',
    status: 'accepted',
  };
  const job = {
    id: route.jobId,
    ownerId: route.workerId,
    ownerEpoch: route.ownerEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    status: 'accepted',
  };
  const onSessionClose = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  let release!: (engine: ManagedVoiceSession) => void;
  const create = vi.fn(
    () =>
      new Promise<ManagedVoiceSession>((resolve) => {
        release = resolve;
      }),
  );
  const fixture = await workerSessionFixture(
    route,
    job,
    (server, store) =>
      new WorkerMediaRuntime(
        { workerId: route.workerId, token: 'worker-fixture-token', httpServer: server },
        store as never,
        { create },
        onSessionClose,
      ),
  );
  try {
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    fixture.send({ type: 'session.close', reason: 'carrier stopped' });
    await vi.waitFor(() => expect(onSessionClose).toHaveBeenCalledOnce(), { timeout: 300 });
    expect(onSessionClose).toHaveBeenCalledWith(route, 'caller_hangup');
    expect(
      fixture.store.queries.some((sql) => sql.includes('INSERT INTO ovo_carrier_callbacks')),
    ).toBe(false);
    release({ dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledExactlyOnceWith('caller_hangup', false));
    expect(
      fixture.store.queries.some((sql) => sql.includes('INSERT INTO ovo_carrier_callbacks')),
    ).toBe(false);
  } finally {
    release({ dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await fixture.close();
  }
});
