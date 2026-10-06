import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { MULAW_8K, type CarrierHostPorts, type CarrierIngress } from '@winsendotai/ovo-contracts';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import {
  fixtureCarrierIngress,
  fixtureInboundFrame,
  fixtureSignature,
} from '../../conformance/src/drivers/fixture-carrier.ts';
import { MediaGateway } from '../src/gateway.ts';
import type { DurableMediaRoute, MediaRouteResolver } from '../src/ports.ts';
import { SessionBridge } from '../src/session-bridge.ts';
import { attachWorkerMediaServer } from '../src/worker-upgrade.ts';

// OBS-4: each failure below used to end a call, or refuse a request, with no log line at all.

const publicBaseUrl = 'https://voice.example.test:8443';
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { level: 'debug', sink: (line) => lines.push(JSON.parse(line)) });
  const find = (event: string) => lines.find((line) => line.event === event);
  return { lines, logger, find };
}

const host = (): CarrierHostPorts =>
  ({
    resolveBinding: async (bindingId: string) => ({
      bindingId,
      pluginId: 'fixture',
      workspaceId: 'workspace',
      config: {},
      secret: 'fixture-secret',
    }),
    verifyUrlSecret: () => true,
  }) as unknown as CarrierHostPorts;

function route(workerEndpoint: string): DurableMediaRoute {
  return {
    sessionId: 'a',
    jobId: 'job-a',
    organizationId: 'org',
    workerId: 'worker-1',
    workerEndpoint,
    ownerEpoch: 7,
    generation: 2,
    carrierId: 'fixture',
    carrierCallId: 'call-a',
    status: 'accepted',
  };
}

const resolver = (row: DurableMediaRoute): MediaRouteResolver => ({
  authenticateSessionRoute: async (sessionId, token) =>
    sessionId === row.sessionId && token === 'token-a' ? row : undefined,
  resolveSessionRoute: async () => row,
  bindCarrierCallId: async () => ({ kind: 'alias', route: row }),
  recordCarrierCallIdMismatch: async () => undefined,
});

async function gateway(
  options: {
    workerEndpoint?: string;
    ingress?: CarrierIngress;
    hostFor?: () => CarrierHostPorts;
  } = {},
) {
  const logs = capture();
  const media = new MediaGateway(
    resolver(route(options.workerEndpoint ?? 'ws://127.0.0.1:1/internal/media')),
    {
      publicBaseUrl,
      workerToken: 'worker-secret',
      ingresses: [options.ingress ?? fixtureCarrierIngress()],
      hostFor: options.hostFor ?? host,
      handshakeTimeoutMs: 1_000,
      logger: logs.logger,
    },
  );
  const { port } = await media.listen();
  resources.push(() => media.close());
  return { ...logs, origin: `127.0.0.1:${port}` };
}

function carrier(origin: string, signature?: string, query = '') {
  const socket = new WebSocket(`ws://${origin}/carriers/fixture/env/media${query}`, {
    headers: {
      'x-fixture-signature':
        signature ??
        fixtureSignature(
          'fixture-secret',
          `wss://voice.example.test:8443/carriers/fixture/env/media`,
        ),
    },
  });
  socket.on('error', () => undefined);
  resources.push(async () => socket.terminate());
  return socket;
}

const start = fixtureInboundFrame({
  type: 'start',
  carrierCallId: 'call-a',
  streamId: 'stream-a',
  format: MULAW_8K,
  routeParams: { sid: 'a', rt: 'token-a' },
});

it('names the call and the transport cause when the worker cannot be reached', async () => {
  const entry = await gateway();
  const socket = carrier(entry.origin);
  await once(socket, 'open');
  socket.send(start);
  await vi.waitFor(() => expect(entry.find('carrier_session_closed')).toBeDefined());
  expect(entry.find('worker_link_error')).toMatchObject({
    level: 'warn',
    sessionId: 'a',
    workerOrigin: 'ws://127.0.0.1:1',
    phase: 'pending',
  });
  expect(entry.find('worker_link_error')?.error).toEqual(expect.stringContaining('ECONNREFUSED'));
  expect(entry.find('worker_route_failed')).toMatchObject({
    carrierId: 'fixture',
    bindingId: 'env',
    carrierCallId: 'call-a',
    streamId: 'stream-a',
    sessionId: 'a',
    generation: 2,
    error: 'worker media link failed',
  });
  expect(entry.find('carrier_session_closed')).toMatchObject({
    level: 'info',
    carrierId: 'fixture',
    bindingId: 'env',
    sessionId: 'a',
    carrierCallId: 'call-a',
    streamId: 'stream-a',
    ownerEpoch: 7,
    generation: 2,
    reason: 'worker media link failed',
  });
  expect(JSON.stringify(entry.lines)).not.toContain('token-a');
  expect(JSON.stringify(entry.lines)).not.toContain('worker-secret');
});

it('logs a refused carrier upgrade with its status and path, never its query secrets', async () => {
  const entry = await gateway();
  const socket = carrier(entry.origin, 'forged', '?sid=a&rt=token-a&t=url-secret');
  await expect(once(socket, 'open')).rejects.toThrow('Unexpected server response: 403');
  expect(entry.find('carrier_upgrade_rejected')).toMatchObject({
    level: 'warn',
    status: 403,
    carrierId: 'fixture',
    bindingId: 'env',
    path: '/carriers/fixture/env/media',
  });
  expect(JSON.stringify(entry.lines)).not.toMatch(/token-a|url-secret/);
});

it('logs the cause of a 400 upgrade instead of dropping it', async () => {
  const entry = await gateway({
    hostFor: () => {
      throw new Error('Gateway composition is not ready');
    },
  });
  const socket = carrier(entry.origin);
  await expect(once(socket, 'open')).rejects.toThrow('Unexpected server response: 400');
  expect(entry.find('carrier_upgrade_failed')).toMatchObject({
    status: 400,
    error: 'Gateway composition is not ready',
  });
});

it('logs a failing carrier HTTP route with its status and cause; the reply is unchanged', async () => {
  const ingress: CarrierIngress = {
    ...fixtureCarrierIngress(),
    routes: [
      {
        method: 'POST',
        purpose: 'status',
        handle: async () => {
          throw new Error('callback store unavailable');
        },
      },
    ],
  };
  const entry = await gateway({ ingress });
  const reply = await fetch(`http://${entry.origin}/carriers/fixture/env/status?t=url-secret`, {
    method: 'POST',
    body: 'CallSid=CA1',
  });
  expect(reply.status).toBe(500);
  expect(entry.find('carrier_http_rejected')).toMatchObject({
    level: 'error',
    carrierId: 'fixture',
    bindingId: 'env',
    purpose: 'status',
    method: 'POST',
    path: '/carriers/fixture/env/status',
    status: 500,
    error: 'callback store unavailable',
  });
  expect(JSON.stringify(entry.lines)).not.toContain('url-secret');
});

class FakeCarrierSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  send(): void {}
  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
  terminate(): void {
    this.close();
  }
}

it('logs a carrier socket error and hands the known IDs to onClosed', () => {
  const entry = capture();
  const socket = new FakeCarrierSocket();
  const closed = vi.fn();
  const ingress = fixtureCarrierIngress();
  new SessionBridge({
    accepted: {
      socket: socket as unknown as WebSocket,
      ingress,
      bindingId: 'env',
      params: {},
      codec: ingress.serializer.createSession({}),
    },
    resolver: resolver(route('ws://127.0.0.1:1/internal/media')),
    dialer: { connect: () => new Promise(() => undefined) },
    logger: entry.logger,
    onClosed: closed,
  });
  socket.emit('message', Buffer.from(start), false);
  socket.emit('error', new Error('read ECONNRESET'));
  expect(entry.find('carrier_socket_error')).toMatchObject({
    carrierId: 'fixture',
    carrierCallId: 'call-a',
    error: 'read ECONNRESET',
  });
  expect(closed).toHaveBeenCalledWith(
    'carrier socket failed',
    { carrierCallId: 'call-a', streamId: 'stream-a' },
    expect.objectContaining({ phase: expect.any(String) }),
  );
});

it('logs why the worker refused a session even when the socket is already gone', async () => {
  const entry = capture();
  const server = createServer();
  const detach = attachWorkerMediaServer({
    httpServer: server,
    token: 'worker-secret',
    logger: entry.logger,
    async onOpen(_open, socket) {
      socket.close(1000, 'error:session-open-failed');
      throw new Error('stt provider rejected credentials');
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  resources.push(async () => {
    await detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as { port: number };
  const denied = new WebSocket(`ws://127.0.0.1:${port}/internal/media`);
  denied.on('error', () => undefined);
  await new Promise((resolve) => denied.on('close', resolve));
  expect(entry.find('worker_media_unauthorized')).toMatchObject({ bearerPresent: false });

  const peer = new WebSocket(`ws://127.0.0.1:${port}/internal/media`, {
    headers: { authorization: 'Bearer worker-secret' },
  });
  await once(peer, 'open');
  peer.send(
    JSON.stringify({
      type: 'session.open',
      protocol: 2,
      sessionId: 'a',
      carrierId: 'fixture',
      bindingId: 'env',
      carrierCallId: 'call-a',
      streamId: 'stream-a',
      ownerEpoch: 7,
      generation: 2,
      format: MULAW_8K,
      playbackEvidence: 'carrier-played',
      clearFlushesMarkers: true,
      routeToken: 'token-a',
    }),
  );
  await once(peer, 'close');
  await vi.waitFor(() =>
    expect(entry.find('worker_session_refused')).toMatchObject({
      sessionId: 'a',
      carrierCallId: 'call-a',
      generation: 2,
      delivered: false,
      error: 'stt provider rejected credentials',
    }),
  );
  expect(JSON.stringify(entry.lines)).not.toMatch(/token-a|worker-secret/);
});
