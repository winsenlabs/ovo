import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import {
  fixtureCarrierIngress,
  fixtureInboundFrame,
} from '../../conformance/src/drivers/fixture-carrier.ts';
import { SessionBridge } from '../src/session-bridge.ts';
import type { DurableMediaRoute } from '../src/ports.ts';
import type { WorkerLinkEvents } from '../src/worker-dialer.ts';

it('closes the real carrier socket when a close-stream serializer has no termination frames', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
  const connection = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const frames: string[] = [];
  client.on('message', (data) => frames.push(data.toString()));
  let bridge: SessionBridge | undefined;
  try {
    const [socket] = (await connection) as [WebSocket];
    await once(client, 'open');
    const source = fixtureCarrierIngress();
    const ingress = {
      ...source,
      capabilities: {
        ...source.capabilities,
        control: { ...source.capabilities.control, hangup: 'close-stream' as const },
      },
    };
    const codec = ingress.serializer.createSession({});
    const route: DurableMediaRoute = {
      sessionId: 'session',
      jobId: 'job',
      organizationId: 'org',
      workerId: 'worker',
      workerEndpoint: 'ws://127.0.0.1/internal/media',
      ownerEpoch: 2,
      generation: 3,
      carrierId: 'fixture',
      carrierCallId: 'call',
      status: 'accepted',
    };
    let worker: WorkerLinkEvents | undefined;
    bridge = new SessionBridge({
      accepted: {
        socket,
        ingress,
        bindingId: 'env',
        params: {},
        codec: {
          ...codec,
          decode: (raw) => codec.decode(raw),
          encode: (command) => codec.encode(command),
          flush: () => [],
          terminate: () => [],
        },
      },
      resolver: {
        authenticateSessionRoute: async () => route,
        resolveSessionRoute: async () => route,
        bindCarrierCallId: async () => ({ kind: 'bound', route }),
        recordCarrierCallIdMismatch: async () => undefined,
      },
      dialer: {
        async connect(_route, _open, events) {
          worker = events;
          return { bufferedBytes: 0, send() {}, close() {} };
        },
      },
    });
    client.send(
      fixtureInboundFrame({
        type: 'start',
        carrierCallId: 'call',
        streamId: 'stream',
        format: MULAW_8K,
        routeParams: { sid: 'session', rt: 'route-token' },
      }),
    );
    await vi.waitFor(() => expect(worker).toBeDefined());
    const closed = once(client, 'close');
    worker!.onMessage({ type: 'session.end', reason: 'terminate' });
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.CLOSED));
    const [code, reason] = await closed;
    expect(code).toBe(1000);
    expect(reason.toString()).toBe('worker ended session: terminate');
    expect(frames).toEqual([]);
    expect(bridge.isClosed).toBe(true);
  } finally {
    bridge?.close();
    client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
