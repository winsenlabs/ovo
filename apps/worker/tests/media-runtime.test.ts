import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import type { DurableJobStore } from '@winsendotai/ovo-plugin-orchestration';
import { describe, expect, it, vi } from 'vitest';
import { WorkerMediaRuntime, type ManagedVoiceSession } from '../src/media-runtime.ts';
import { mediaRuntimeFixture, mediaSessionOpen } from './media-runtime-fixtures.ts';

describe('worker media runtime', () => {
  it('finalizes a route if pre-accept audio overflows while engine creation is pending', async () => {
    const { route, job } = mediaRuntimeFixture();
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
      socket.send(JSON.stringify(mediaSessionOpen(route)));
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
    ['unclaimed token', false, 'token', 'slot-1', 'none', 'media route token was not claimed'],
    [
      'wrong route token',
      true,
      'wrong-token',
      'slot-1',
      'none',
      'media route token was not claimed',
    ],
    ['stale worker slot', true, 'token', 'slot-2', 'none', 'worker slot lease no longer owns'],
    [
      'stale generation',
      true,
      'token',
      'slot-1',
      'generation',
      'media route does not match the active owner',
    ],
    [
      'stale session ID',
      true,
      'token',
      'slot-1',
      'sessionId',
      'media route does not match the active owner',
    ],
    [
      'stale owner epoch',
      true,
      'token',
      'slot-1',
      'ownerEpoch',
      'media route does not match the active owner',
    ],
  ] as const)(
    'rejects %s on the worker health port before engine composition',
    async (_name, claimed, token, slotEpoch, mismatch, message) => {
      const { route, job } = mediaRuntimeFixture();
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
            ...mediaSessionOpen(route, token),
            ...(mismatch === 'generation' ? { generation: route.generation - 1 } : {}),
            ...(mismatch === 'sessionId' ? { sessionId: 'stale-session' } : {}),
            ...(mismatch === 'ownerEpoch' ? { ownerEpoch: route.ownerEpoch - 1 } : {}),
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
    const { route, job } = mediaRuntimeFixture();
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
});
