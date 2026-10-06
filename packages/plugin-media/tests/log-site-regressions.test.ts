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
import type { WorkerLink } from '../src/worker-dialer.ts';

// Wave 1 added these log lines with no test that fails when one is removed. Each test below
// drives the failure and asserts the exact event, so deleting the line turns it red.

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { level: 'debug', sink: (line) => lines.push(JSON.parse(line)) });
  return { lines, logger, find: (event: string) => lines.find((line) => line.event === event) };
}

const row: DurableMediaRoute = {
  sessionId: 'a',
  jobId: 'job-a',
  organizationId: 'org',
  workerId: 'worker-1',
  workerEndpoint: 'ws://127.0.0.1:1/internal/media',
  ownerEpoch: 7,
  generation: 2,
  carrierId: 'fixture',
  carrierCallId: 'call-a',
  status: 'accepted',
};
const resolver: MediaRouteResolver = {
  authenticateSessionRoute: async () => row,
  resolveSessionRoute: async () => row,
  bindCarrierCallId: async () => ({ kind: 'alias', route: row }),
  recordCarrierCallIdMismatch: async () => undefined,
};
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

async function gateway(ingress: CarrierIngress = fixtureCarrierIngress()) {
  const logs = capture();
  const media = new MediaGateway(resolver, {
    publicBaseUrl: 'https://voice.example.test:8443',
    workerToken: 'worker-secret',
    ingresses: [ingress],
    hostFor: host,
    handshakeTimeoutMs: 1_000,
    logger: logs.logger,
  });
  const { port } = await media.listen();
  resources.push(() => media.close());
  return { ...logs, media, origin: `127.0.0.1:${port}` };
}

it('logs carrier_http_failed when the carrier router itself throws', async () => {
  const entry = await gateway();
  (entry.media as unknown as { router: { handleHttp: () => Promise<boolean> } }).router.handleHttp =
    async () => {
      throw new Error('router lost its route table');
    };
  const reply = await fetch(`http://${entry.origin}/carriers/fixture/env/status?t=url-secret`, {
    method: 'POST',
    body: 'CallSid=CA1',
  });
  expect(reply.status).toBe(500);
  expect(entry.find('carrier_http_failed')).toMatchObject({
    level: 'error',
    method: 'POST',
    path: '/carriers/fixture/env/status',
    error: 'router lost its route table',
  });
  expect(JSON.stringify(entry.lines)).not.toContain('url-secret');
});

it('logs carrier_session_setup_failed when the codec cannot start a session', async () => {
  const base = fixtureCarrierIngress();
  const ingress: CarrierIngress = {
    ...base,
    serializer: {
      ...base.serializer,
      createSession: () => {
        throw new Error('codec rejected the stream parameters');
      },
    },
  };
  const entry = await gateway(ingress);
  const socket = new WebSocket(`ws://${entry.origin}/carriers/fixture/env/media`, {
    headers: {
      'x-fixture-signature': fixtureSignature(
        'fixture-secret',
        'wss://voice.example.test:8443/carriers/fixture/env/media',
      ),
    },
  });
  socket.on('error', () => undefined);
  resources.push(async () => socket.terminate());
  const [code] = (await once(socket, 'close')) as [number];
  expect(code).toBe(1011);
  expect(entry.find('carrier_session_setup_failed')).toMatchObject({
    level: 'warn',
    error: 'codec rejected the stream parameters',
  });
});

it('logs worker_session_not_accepted when the worker handler returns without accepting', async () => {
  const entry = capture();
  const server = createServer();
  const detach = attachWorkerMediaServer({
    httpServer: server,
    token: 'worker-secret',
    logger: entry.logger,
    async onOpen() {
      // Neither handoff() nor a throw: the session would hang with no record of why.
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  resources.push(async () => {
    await detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as { port: number };
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
  const [code] = (await once(peer, 'close')) as [number];
  expect(code).toBe(1011);
  expect(entry.find('worker_session_not_accepted')).toMatchObject({
    level: 'warn',
    sessionId: 'a',
    carrierCallId: 'call-a',
    streamId: 'stream-a',
    generation: 2,
  });
  expect(JSON.stringify(entry.lines)).not.toContain('token-a');
});

it('logs worker_close_notify_failed and still closes the carrier when the worker link is gone', async () => {
  const entry = capture();
  const ingress = fixtureCarrierIngress();
  const carrier = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send: () => undefined,
    close(this: { readyState: number }) {
      this.readyState = WebSocket.CLOSED;
    },
    terminate(this: { readyState: number }) {
      this.readyState = WebSocket.CLOSED;
    },
  });
  const link: WorkerLink = {
    bufferedBytes: 0,
    send: () => {
      throw new Error('worker socket is not open');
    },
    close: vi.fn(),
  };
  const connect = vi.fn(async () => link);
  const bridge = new SessionBridge({
    accepted: {
      socket: carrier as unknown as WebSocket,
      ingress,
      bindingId: 'env',
      params: {},
      codec: ingress.serializer.createSession({}),
    },
    resolver,
    dialer: { connect },
    logger: entry.logger,
  });
  carrier.emit(
    'message',
    Buffer.from(
      fixtureInboundFrame({
        type: 'start',
        carrierCallId: 'call-a',
        streamId: 'stream-a',
        format: MULAW_8K,
        routeParams: { sid: 'a', rt: 'token-a' },
      }),
    ),
    false,
  );
  // The link only exists once the worker accepted; then the gateway closes at its drain deadline.
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));
  bridge.close('gateway closing');
  expect(entry.find('worker_close_notify_failed')).toMatchObject({
    level: 'warn',
    reason: 'gateway closing',
    error: 'worker socket is not open',
    sessionId: 'a',
  });
  expect(link.close).toHaveBeenCalledWith('gateway closing');
  expect(carrier.readyState).toBe(WebSocket.CLOSED);
});
