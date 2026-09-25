import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { MULAW_8K, type CarrierHostPorts, type CarrierIngress } from '@winsendotai/ovo-contracts';
import {
  fixtureCarrierIngress,
  fixtureInboundFrame,
  fixtureSignature,
} from '../../conformance/src/drivers/fixture-carrier.ts';
import { MediaGateway } from '../src/gateway.ts';
import type {
  DurableMediaRoute,
  GatewayToWorkerMessage,
  MediaRouteResolver,
} from '../src/ports.ts';

const publicBaseUrl = 'https://voice.example.test:8443';
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

function host(): CarrierHostPorts {
  return {
    resolveBinding: async (bindingId: string) => ({
      bindingId,
      pluginId: 'fixture',
      workspaceId: 'workspace',
      config: {},
      secret: 'fixture-secret',
    }),
    verifyUrlSecret: () => true,
  } as unknown as CarrierHostPorts;
}

function route(sessionId: string, workerEndpoint: string): DurableMediaRoute {
  return {
    sessionId,
    jobId: `job-${sessionId}`,
    organizationId: 'org',
    workerId: 'worker-1',
    workerEndpoint,
    ownerEpoch: 7,
    generation: 2,
    carrierId: 'fixture',
    carrierCallId: `call-${sessionId}`,
    status: 'accepted',
  };
}

function resolver(routes: DurableMediaRoute[]): MediaRouteResolver {
  return {
    authenticateSessionRoute: async (sessionId, token) =>
      token === `token-${sessionId}`
        ? routes.find((row) => row.sessionId === sessionId)
        : undefined,
    resolveSessionRoute: async ({ carrierCallId }) =>
      routes.find(
        (row) => row.carrierCallId === carrierCallId || row.carrierStreamCallId === carrierCallId,
      ),
    bindCarrierCallId: async ({ sessionId, carrierCallId }) => {
      const row = routes.find((candidate) => candidate.sessionId === sessionId);
      if (!row) return { kind: 'unmatched' };
      if (row.carrierStreamCallId && row.carrierStreamCallId !== carrierCallId)
        return { kind: 'conflict' };
      row.carrierStreamCallId = carrierCallId;
      return { kind: 'alias', route: row };
    },
    recordCarrierCallIdMismatch: async () => undefined,
  };
}

async function worker(
  onMessage: (peer: WebSocket, message: GatewayToWorkerMessage, bearer: string | undefined) => void,
): Promise<string> {
  const health = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404).end();
  });
  const socketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  health.on('upgrade', (request, socket, head) => {
    if (request.url !== '/internal/media') return socket.destroy();
    socketServer.handleUpgrade(request, socket, head, (peer) => {
      peer.on('message', (raw) =>
        onMessage(
          peer,
          JSON.parse(raw.toString()) as GatewayToWorkerMessage,
          request.headers.authorization,
        ),
      );
    });
  });
  health.listen(0, '127.0.0.1');
  await once(health, 'listening');
  resources.push(async () => {
    for (const peer of socketServer.clients) peer.terminate();
    socketServer.close();
    health.closeAllConnections();
    await new Promise<void>((resolve) => health.close(() => resolve()));
  });
  const address = health.address();
  if (!address || typeof address === 'string') throw new Error('worker health port unavailable');
  return `ws://127.0.0.1:${address.port}/internal/media`;
}

async function gateway(
  routes: DurableMediaRoute[],
  options: {
    ingress?: CarrierIngress;
    drainTimeoutMs?: number;
    handshakeTimeoutMs?: number;
  } = {},
): Promise<{ gateway: MediaGateway; origin: string }> {
  const media = new MediaGateway(resolver(routes), {
    publicBaseUrl,
    workerToken: 'worker-secret',
    ingresses: [options.ingress ?? fixtureCarrierIngress()],
    hostFor: () => host(),
    drainTimeoutMs: options.drainTimeoutMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
  });
  const { port } = await media.listen();
  resources.push(() => media.close());
  return { gateway: media, origin: `http://127.0.0.1:${port}` };
}

async function carrier(origin: string, path = '/carriers/fixture/env/media'): Promise<WebSocket> {
  const publicPath = path.split('?', 1)[0]!;
  const socket = new WebSocket(origin.replace('http:', 'ws:') + path, {
    headers: {
      'x-fixture-signature': fixtureSignature(
        'fixture-secret',
        `wss://voice.example.test:8443${publicPath}`,
      ),
    },
    perMessageDeflate: false,
  });
  await once(socket, 'open');
  resources.push(async () => {
    if (socket.readyState === WebSocket.OPEN) socket.terminate();
  });
  return socket;
}

function start(sessionId: string) {
  return fixtureInboundFrame({
    type: 'start',
    carrierCallId: `call-${sessionId}`,
    streamId: `stream-${sessionId}`,
    format: MULAW_8K,
    routeParams: { sid: sessionId, rt: `token-${sessionId}` },
  });
}

it('runs fixture media through the real gateway, worker health port, fragmented frames and ping', async () => {
  const workerMessages: GatewayToWorkerMessage[] = [];
  const endpoint = await worker((peer, message, bearer) => {
    expect(bearer).toBe('Bearer worker-secret');
    workerMessages.push(message);
    if (message.type === 'session.open') peer.send(JSON.stringify({ type: 'session.accept' }));
    if (message.type === 'media.dtmf') {
      peer.send(JSON.stringify({ type: 'audio', payload: 'AQID' }));
      peer.send(JSON.stringify({ type: 'mark', name: 'reply-played' }));
    }
  });
  const entry = await gateway([route('a', endpoint)]);
  expect((await fetch(`${entry.origin}/health`)).status).toBe(200);
  const socket = await carrier(entry.origin);
  const outbound: unknown[] = [];
  socket.on('message', (raw) => outbound.push(JSON.parse(raw.toString())));
  socket.send(start('a'));
  const audio = fixtureInboundFrame({
    type: 'audio',
    seq: 1,
    timestampMs: 13,
    payload: new Uint8Array([8, 9]),
  });
  const split = Math.floor(audio.length / 2);
  socket.send(audio.slice(0, split), { fin: false });
  socket.ping('mid-fragment');
  socket.send(audio.slice(split), { fin: true });
  socket.send(fixtureInboundFrame({ type: 'dtmf', digit: '7' }));
  await vi.waitFor(() => expect(workerMessages).toHaveLength(3));
  expect(workerMessages).toMatchObject([
    {
      type: 'session.open',
      protocol: 2,
      sessionId: 'a',
      carrierId: 'fixture',
      carrierCallId: 'call-a',
      bindingId: 'env',
      ownerEpoch: 7,
      generation: 2,
      routeToken: 'token-a',
    },
    { type: 'media.audio', payload: 'CAk=', sequenceNumber: 1, timestampMs: 13 },
    { type: 'media.dtmf', digit: '7' },
  ]);
  await vi.waitFor(() => expect(outbound).toHaveLength(2));
  expect(outbound).toMatchObject([
    { event: 'media', streamSid: 'stream-a', media: { payload: 'AQID' } },
    { event: 'mark', streamSid: 'stream-a', mark: { name: 'reply-played' } },
  ]);
});

it('rejects an oversized fragmented carrier message without dialing a worker', async () => {
  const opens: GatewayToWorkerMessage[] = [];
  const endpoint = await worker((_peer, message) => opens.push(message));
  const entry = await gateway([route('a', endpoint)]);
  const socket = await carrier(entry.origin);
  const closed = once(socket, 'close');
  socket.send('x'.repeat(600_000), { fin: false });
  socket.ping('mid-fragment');
  socket.send('x'.repeat(600_000), { fin: true });
  const [code] = await closed;
  expect(code).toBe(1009);
  expect(opens).toEqual([]);
});

it('rejects a signature for a different public URL before accepting the carrier socket', async () => {
  const opens: GatewayToWorkerMessage[] = [];
  const endpoint = await worker((_peer, message) => opens.push(message));
  const entry = await gateway([route('a', endpoint)]);
  const socket = new WebSocket(
    `${entry.origin.replace('http:', 'ws:')}/carriers/fixture/env/media`,
    {
      headers: {
        'x-fixture-signature': fixtureSignature('fixture-secret', 'wss://wrong.test/media'),
      },
    },
  );
  const status = await new Promise<number | undefined>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('error', reject);
  });
  expect(status).toBe(401);
  expect(opens).toEqual([]);
  socket.terminate();
});

it('holds more than the old 25-frame limit and sends serializer termination after worker end', async () => {
  const received: GatewayToWorkerMessage[] = [];
  let workerPeer: WebSocket | undefined;
  const endpoint = await worker((peer, message) => {
    received.push(message);
    if (message.type === 'session.open') workerPeer = peer;
  });
  const source = fixtureCarrierIngress();
  const ingress: CarrierIngress = {
    ...source,
    serializer: {
      ...source.serializer,
      createSession(params) {
        const codec = source.serializer.createSession(params);
        return {
          decode: (raw) => codec.decode(raw),
          encode: (command) => codec.encode(command),
          flush: () => codec.flush(),
          terminate: () => [JSON.stringify({ event: 'terminate' })],
        };
      },
    },
  };
  const entry = await gateway([route('a', endpoint)], { ingress });
  const socket = await carrier(entry.origin);
  const outbound: unknown[] = [];
  socket.on('message', (raw) => outbound.push(JSON.parse(raw.toString())));
  socket.send(start('a'));
  await vi.waitFor(() => expect(workerPeer).toBeDefined());
  for (let seq = 1; seq <= 30; seq++)
    socket.send(
      fixtureInboundFrame({
        type: 'audio',
        seq,
        timestampMs: seq * 20,
        payload: new Uint8Array(160),
      }),
    );
  socket.send(fixtureInboundFrame({ type: 'dtmf', digit: '8' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(received).toHaveLength(1);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  workerPeer!.send(JSON.stringify({ type: 'session.accept' }));
  await vi.waitFor(() => expect(received).toHaveLength(32));
  expect(received.at(-1)).toEqual({ type: 'media.dtmf', digit: '8' });
  const closed = once(socket, 'close');
  workerPeer!.send(JSON.stringify({ type: 'session.end', reason: 'terminate' }));
  await closed;
  expect(outbound.at(-1)).toEqual({ event: 'terminate' });
});

it('isolates a rejected first session while a neighboring call reaches the same worker', async () => {
  const messages: GatewayToWorkerMessage[] = [];
  const endpoint = await worker((peer, message) => {
    messages.push(message);
    if (message.type !== 'session.open') return;
    peer.send(
      JSON.stringify(
        message.sessionId === 'bad'
          ? { type: 'session.reject', reason: 'bad route' }
          : { type: 'session.accept' },
      ),
    );
  });
  const entry = await gateway([route('bad', endpoint), route('good', endpoint)]);
  const rejected = await carrier(entry.origin);
  const rejectedClose = once(rejected, 'close');
  rejected.send(start('bad'));
  await rejectedClose;
  const good = await carrier(entry.origin);
  good.send(start('good'));
  good.send(
    fixtureInboundFrame({ type: 'audio', seq: 1, timestampMs: 0, payload: new Uint8Array([2]) }),
  );
  await vi.waitFor(() =>
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'media.audio', payload: 'Ag==' }),
    ),
  );
  expect(good.readyState).toBe(WebSocket.OPEN);
});

it('routes two gateway instances to one worker and holds existing media until drain deadline', async () => {
  const opened: string[] = [];
  const endpoint = await worker((peer, message) => {
    if (message.type === 'session.open') {
      opened.push(message.sessionId);
      peer.send(JSON.stringify({ type: 'session.accept' }));
    }
  });
  const first = await gateway([route('one', endpoint)], { drainTimeoutMs: 120 });
  const second = await gateway([route('two', endpoint)]);
  const left = await carrier(first.origin);
  const right = await carrier(second.origin);
  left.send(start('one'));
  right.send(start('two'));
  await vi.waitFor(() => expect(opened).toEqual(['one', 'two']));
  const drained = first.gateway.drain();
  await vi.waitFor(async () => expect((await fetch(`${first.origin}/health`)).status).toBe(503));
  expect(left.readyState).toBe(WebSocket.OPEN);
  expect(right.readyState).toBe(WebSocket.OPEN);
  await drained;
  await vi.waitFor(() => expect(left.readyState).toBe(WebSocket.CLOSED));
  expect(right.readyState).toBe(WebSocket.OPEN);
});
