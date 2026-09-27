import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import type { DurableMediaRoute, GatewayToWorkerMessage } from '../src/ports.ts';
import { WorkerDialer } from '../src/worker-dialer.ts';

const servers: Array<{ http: Server; ws: WebSocketServer }> = [];
afterEach(async () => {
  for (const { http, ws } of servers.splice(0)) {
    for (const peer of ws.clients) peer.terminate();
    ws.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

async function worker(onConnection: (peer: WebSocket, bearer: string | undefined) => void) {
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    if (request.url !== '/internal/media') return socket.destroy();
    ws.handleUpgrade(request, socket, head, (peer) =>
      onConnection(peer, request.headers.authorization),
    );
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  servers.push({ http, ws });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('worker has no port');
  return `ws://127.0.0.1:${address.port}/internal/media`;
}

function route(workerEndpoint: string): DurableMediaRoute {
  return {
    sessionId: 'session',
    jobId: 'job',
    organizationId: 'org',
    workerId: 'worker',
    workerEndpoint,
    ownerEpoch: 2,
    generation: 3,
    status: 'accepted',
  };
}

const open: Extract<GatewayToWorkerMessage, { type: 'session.open' }> = {
  type: 'session.open',
  protocol: 2,
  sessionId: 'session',
  carrierId: 'fixture',
  bindingId: 'env',
  carrierCallId: 'call',
  streamId: 'stream',
  ownerEpoch: 2,
  generation: 3,
  format: MULAW_8K,
  playbackEvidence: 'carrier-played',
  clearFlushesMarkers: true,
  routeToken: 'secret-route-token',
};

it('dials the durable worker endpoint with Bearer auth and waits for session.accept', async () => {
  const seen: unknown[] = [];
  const endpoint = await worker((peer, bearer) => {
    seen.push(bearer);
    peer.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as GatewayToWorkerMessage;
      seen.push(message);
      if (message.type === 'session.open') peer.send(JSON.stringify({ type: 'session.accept' }));
      else peer.send(JSON.stringify({ type: 'mark', name: 'played-1' }));
    });
  });
  const delivered: unknown[] = [];
  const link = await new WorkerDialer({ workerToken: 'worker-secret' }).connect(
    route(endpoint),
    open,
    { onMessage: (message) => delivered.push(message), onClose: () => undefined },
  );
  expect(seen).toEqual(['Bearer worker-secret', open]);
  link.send({ type: 'media.dtmf', digit: '5' });
  await vi.waitFor(() => expect(seen).toHaveLength(3));
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  expect(seen[2]).toEqual({ type: 'media.dtmf', digit: '5' });
  expect(delivered).toEqual([{ type: 'mark', name: 'played-1' }]);
  link.close();
});

it('refuses worker rejection and a response that emits media before acceptance', async () => {
  const endpoint = await worker((peer) => {
    peer.once('message', () =>
      peer.send(JSON.stringify({ type: 'session.reject', reason: 'bad token' })),
    );
  });
  const dialer = new WorkerDialer({ workerToken: 'worker-secret' });
  await expect(
    dialer.connect(route(endpoint), open, { onMessage: () => undefined, onClose: () => undefined }),
  ).rejects.toThrow('bad token');
  const endpoint2 = await worker((peer) => {
    peer.once('message', () => peer.send(JSON.stringify({ type: 'audio', payload: 'AQ==' })));
  });
  await expect(
    dialer.connect(route(endpoint2), open, {
      onMessage: () => undefined,
      onClose: () => undefined,
    }),
  ).rejects.toThrow('before session acceptance');
});

it('cancels a pending dial and reports an accepted worker disconnect exactly once', async () => {
  const pendingEndpoint = await worker((peer) => {
    peer.on('message', () => undefined);
  });
  const dialer = new WorkerDialer({ workerToken: 'worker-secret', handshakeTimeoutMs: 1_000 });
  const controller = new AbortController();
  const pending = dialer.connect(
    route(pendingEndpoint),
    open,
    { onMessage: () => undefined, onClose: () => undefined },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toThrow('worker media dial cancelled');

  const acceptedEndpoint = await worker((peer) => {
    peer.once('message', () => {
      peer.send(JSON.stringify({ type: 'session.accept' }));
      peer.close(1000, 'worker done');
    });
  });
  const closed: string[] = [];
  await dialer.connect(route(acceptedEndpoint), open, {
    onMessage: () => undefined,
    onClose: (reason) => closed.push(reason),
  });
  await vi.waitFor(() => expect(closed).toHaveLength(1));
  expect(closed[0]).toContain('worker done');
});

it('rejects a worker endpoint carrying credentials, a query, or another path', () => {
  const dialer = new WorkerDialer({ workerToken: 'worker-secret' });
  const events = { onMessage: () => undefined, onClose: () => undefined };
  for (const endpoint of [
    'ws://user:pass@worker.test/internal/media',
    'ws://worker.test/internal/media?token=secret',
    'ws://worker.test/worker',
  ]) {
    expect(() => dialer.connect(route(endpoint), open, events)).toThrow('Worker endpoint');
  }
});
