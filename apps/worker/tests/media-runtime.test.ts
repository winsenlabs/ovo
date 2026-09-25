import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import WebSocket from 'ws';
import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { WorkerMediaSession } from '@winsendotai/ovo-plugin-media';
import { describe, expect, it, vi } from 'vitest';
import { WorkerMediaRuntime, type ManagedVoiceSession } from '../src/media-runtime.ts';
import { WorkerMediaLink } from '../src/worker-media-server.ts';

function fixture() {
  const route: SessionRoute = {
    sessionId: 'session-1',
    jobId: 'job-1',
    organizationId: 'workspace-1',
    workerId: 'worker-1',
    workerEndpoint: 'ws://worker-1/internal/media',
    ownerEpoch: 7,
    generation: 2,
    dialRequestId: 'job-1:7',
    carrierCallId: 'CA1',
    status: 'accepted',
    handshakeExpiresAt: new Date(Date.now() + 60_000),
  };
  const job: DurableJob = {
    id: route.jobId,
    workspaceId: route.organizationId,
    idempotencyKey: 'job-1',
    payload: {},
    status: 'accepted',
    ownerId: route.workerId,
    ownerEpoch: route.ownerEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  let closeListener: ((reason: string) => void) | undefined;
  const media = {
    identity: {
      sessionId: route.sessionId,
      carrierId: 'twilio',
      bindingId: 'env',
      carrierCallId: route.carrierCallId,
      streamId: 'MZ1',
      ownerEpoch: route.ownerEpoch,
      generation: route.generation,
    },
    onClose(listener: (reason: string) => void) {
      closeListener = listener;
      return () => undefined;
    },
  } as unknown as WorkerMediaSession;
  return { route, job, media, close: (reason: string) => closeListener?.(reason) };
}

function sessionOpen(route: SessionRoute, routeToken = 'token') {
  if (!route.carrierCallId) throw new Error('fixture route has no carrier call ID');
  return {
    type: 'session.open',
    protocol: 2,
    sessionId: route.sessionId,
    carrierId: route.carrierId ?? 'twilio',
    bindingId: route.bindingId ?? 'env',
    carrierCallId: route.carrierCallId,
    streamId: 'MZ1',
    ownerEpoch: route.ownerEpoch,
    generation: route.generation,
    format: MULAW_8K,
    playbackEvidence: 'carrier-played',
    clearFlushesMarkers: true,
    routeToken,
  } as const;
}

describe('worker media runtime', () => {
  it.each(['max_duration', 'ownership_lost'] as const)(
    'sends carrier termination and preserves the %s engine reason',
    async (reason) => {
      const sent: unknown[] = [];
      const socket = new EventEmitter() as EventEmitter & {
        readyState: number;
        bufferedAmount: number;
        send(value: string, callback?: (error?: Error) => void): void;
        close(): void;
      };
      socket.readyState = WebSocket.OPEN;
      socket.bufferedAmount = 0;
      socket.send = (value, callback) => {
        sent.push(JSON.parse(value));
        callback?.();
      };
      socket.close = vi.fn();
      const link = new WorkerMediaLink(
        sessionOpen(fixture().route),
        socket as unknown as WebSocket,
      );
      const onClose = vi.fn();
      link.onClose(onClose);
      await link.terminate(reason);
      expect(sent).toEqual([{ type: 'session.end', reason: 'terminate' }]);
      expect(onClose).toHaveBeenCalledWith(reason);
      await expect(link.clear()).resolves.toBeUndefined();
    },
  );

  it('finalizes a route if pre-accept audio overflows while engine creation is pending', async () => {
    const { route, job } = fixture();
    route.carrierId = 'twilio';
    route.bindingId = 'env';
    let releaseFactory!: (engine: ManagedVoiceSession) => void;
    const dispose = vi.fn(async () => undefined);
    const onSessionClose = vi.fn(async () => undefined);
    const server = createServer((_request, response) => response.writeHead(404).end());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('worker test server has no port');
    const query = vi.fn(async (sql: string) =>
      sql.includes('FROM ovo_session_routes')
        ? {
            rows: [
              {
                job_id: job.id,
                organization_id: route.organizationId,
                carrier_id: route.carrierId,
                handshake_token_hash: createHash('sha256').update('token').digest('hex'),
                handshake_claimed_at: new Date(),
                worker_slot_epoch: 'slot-1',
              },
            ],
          }
        : { rows: [{ ownership_epoch: 'slot-1' }] },
    );
    const runtime = new WorkerMediaRuntime(
      { workerId: route.workerId, token: 'test', httpServer: server },
      {
        pool: { query },
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      {
        create: () =>
          new Promise<ManagedVoiceSession>((resolve) => {
            releaseFactory = resolve;
          }),
      },
      onSessionClose,
    );
    await runtime.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/media`, {
      headers: { authorization: 'Bearer test' },
    });
    try {
      await once(socket, 'open');
      socket.send(JSON.stringify(sessionOpen(route)));
      const [decision] = await once(socket, 'message');
      expect(JSON.parse(decision.toString())).toEqual({ type: 'session.accept' });
      await vi.waitFor(() => expect(releaseFactory).toBeTypeOf('function'));
      const frame = JSON.stringify({
        type: 'media.audio',
        payload: Buffer.alloc(8_192).toString('base64'),
        sequenceNumber: 1,
        timestampMs: 0,
      });
      for (let index = 0; index < 4; index += 1) socket.send(frame);
      await vi.waitFor(() =>
        expect(onSessionClose).toHaveBeenCalledWith(route, 'error:worker-input-buffer-overflow'),
      );
      releaseFactory({ dispose });
      await vi.waitFor(() =>
        expect(dispose).toHaveBeenCalledWith('error:worker-input-buffer-overflow', false),
      );
      expect(onSessionClose).toHaveBeenCalledTimes(1);
    } finally {
      if (releaseFactory) releaseFactory({ dispose });
      socket.terminate();
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ['unclaimed token', false, 'token', 'slot-1', false, 'media route token was not claimed'],
    [
      'wrong route token',
      true,
      'wrong-token',
      'slot-1',
      false,
      'media route token was not claimed',
    ],
    ['stale worker slot', true, 'token', 'slot-2', false, 'worker slot lease no longer owns'],
    [
      'stale generation',
      true,
      'token',
      'slot-1',
      true,
      'media route does not match the active owner',
    ],
  ] as const)(
    'rejects %s on the worker health port before engine composition',
    async (_name, claimed, token, slotEpoch, staleGeneration, message) => {
      const { route, job } = fixture();
      route.carrierId = 'twilio';
      route.bindingId = 'env';
      const server = createServer((_request, response) => response.writeHead(404).end());
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('worker test server has no port');
      const query = vi.fn(async (sql: string) =>
        sql.includes('FROM ovo_session_routes')
          ? {
              rows: [
                {
                  job_id: job.id,
                  organization_id: route.organizationId,
                  carrier_id: route.carrierId,
                  handshake_token_hash: createHash('sha256').update('token').digest('hex'),
                  handshake_claimed_at: claimed ? new Date() : null,
                  worker_slot_epoch: 'slot-1',
                },
              ],
            }
          : { rows: [{ ownership_epoch: slotEpoch }] },
      );
      const factory = { create: vi.fn() };
      const runtime = new WorkerMediaRuntime(
        { workerId: route.workerId, token: 'test', httpServer: server },
        {
          pool: { query },
          resolveSessionRoute: vi.fn(async () => route),
          get: vi.fn(async () => job),
        } as unknown as DurableJobStore,
        factory,
      );
      await runtime.start();
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/media`, {
        headers: { authorization: 'Bearer test' },
      });
      try {
        await once(socket, 'open');
        socket.send(
          JSON.stringify({
            ...sessionOpen(route, token),
            ...(staleGeneration ? { generation: route.generation - 1 } : {}),
          }),
        );
        const [decision] = await once(socket, 'message');
        expect(JSON.parse(decision.toString())).toMatchObject({
          type: 'session.reject',
          reason: expect.stringContaining(message),
        });
        expect(factory.create).not.toHaveBeenCalled();
      } finally {
        socket.terminate();
        await runtime.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('rejects a wrong worker bearer before any route lookup', async () => {
    const { route, job } = fixture();
    const server = createServer((_request, response) => response.writeHead(404).end());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('worker test server has no port');
    const store = { get: vi.fn(async () => job) } as unknown as DurableJobStore;
    const factory = { create: vi.fn() };
    const runtime = new WorkerMediaRuntime(
      { workerId: route.workerId, token: 'correct', httpServer: server },
      store,
      factory,
    );
    await runtime.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/media`, {
      headers: { authorization: 'Bearer wrong' },
    });
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve(response.statusCode);
        });
        socket.once('open', () => resolve(undefined));
        socket.once('error', reject);
      });
      expect(status).toBe(401);
      expect(factory.create).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ['cost-max-duration', 'max_duration'],
    ['worker-shutdown', 'drain'],
    ['media idle deadline exceeded', 'caller_idle'],
    ['owning worker disconnected', 'ownership_lost'],
  ] as const)('passes a typed end reason for %s', async (raw, expected) => {
    const { route, job, media, close } = fixture();
    const dispose = vi.fn(async () => undefined);
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      { create: async () => ({ dispose }) },
    );
    await open(runtime, media, route);
    close(raw);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith(expected, false));
  });

  it('keeps the requested reason when a close-stream carrier terminates media first', async () => {
    const { route, job, media } = fixture();
    const dispose = vi.fn(async () => undefined);
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      { create: async () => ({ dispose }) },
    );
    await open(runtime, media, route);
    await runtime.terminate(route.sessionId, 'ownership_lost');
    expect(dispose).toHaveBeenCalledWith('ownership_lost');
  });

  it('opens media only for the current durable owner and disposes on carrier close', async () => {
    const { route, job, media, close } = fixture();
    const dispose = vi.fn(async () => undefined);
    const onSessionClose = vi.fn(async () => undefined);
    const factory = { create: vi.fn(async () => ({ dispose }) as ManagedVoiceSession) };
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      factory,
      onSessionClose,
    );

    await open(runtime, media, route);
    expect(factory.create).toHaveBeenCalledWith({ job, route, media });
    close('carrier stopped');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith('caller_hangup', false));
    await vi.waitFor(() => expect(onSessionClose).toHaveBeenCalledWith(route, 'caller_hangup'));
  });

  it.each([
    ['sessionId', 'stale-session'],
    ['ownerEpoch', 6],
    ['generation', 1],
  ] as const)('rejects a stale %s before creating an engine', async (field, value) => {
    const { route, job, media } = fixture();
    Object.assign(media.identity, { [field]: value });
    const factory = { create: vi.fn() };
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      factory,
    );

    await expect(open(runtime, media, route)).rejects.toThrow('durable route identity');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('runs admission before composition and closes admitted state when composition fails', async () => {
    const { route, job, media } = fixture();
    const beforeSessionOpen = vi.fn(async () => undefined);
    const onSessionClose = vi.fn(async () => undefined);
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      { create: vi.fn(async () => Promise.reject(new Error('composition failed'))) },
      onSessionClose,
      beforeSessionOpen,
    );

    await expect(open(runtime, media, route)).rejects.toThrow('composition failed');
    expect(beforeSessionOpen).toHaveBeenCalledWith(job, route);
    expect(onSessionClose).toHaveBeenCalledWith(route, 'error:session-open-failed');
  });
});

function open(
  runtime: WorkerMediaRuntime,
  media: WorkerMediaSession,
  route: SessionRoute,
): Promise<void> {
  return (
    runtime as unknown as {
      open(session: WorkerMediaSession, selectedRoute: SessionRoute): Promise<void>;
    }
  ).open(media, route);
}
