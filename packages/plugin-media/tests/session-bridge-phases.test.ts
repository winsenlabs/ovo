import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import {
  fixtureCarrierIngress,
  fixtureInboundFrame,
} from '../../conformance/src/drivers/fixture-carrier.ts';
import { MediaGateway } from '../src/gateway.ts';
import type { DurableMediaRoute, MediaRouteResolver } from '../src/ports.ts';
import type { SessionBridgeTimings } from '../src/call-start-clock.ts';
import { SessionBridge } from '../src/session-bridge.ts';
import type { WorkerLink } from '../src/worker-dialer.ts';

class CarrierSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  send(): void {}
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate(): void {
    this.close();
  }
  receive(frame: string): void {
    this.emit('message', Buffer.from(frame), false);
  }
}

const ingress = fixtureCarrierIngress();
const route: DurableMediaRoute = {
  sessionId: 'session',
  jobId: 'job',
  organizationId: 'org',
  workerId: 'worker',
  workerEndpoint: 'ws://worker.test:4100/internal/media',
  ownerEpoch: 2,
  generation: 3,
  carrierId: 'fixture',
  bindingId: undefined,
  carrierCallId: 'call',
  status: 'accepted',
};
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function bridge(input: { routeHangs?: boolean; dialHangs?: boolean }) {
  const socket = new CarrierSocket();
  const closed: { reason: string; timings: SessionBridgeTimings }[] = [];
  const resolver: MediaRouteResolver = {
    authenticateSessionRoute: vi.fn(async () =>
      input.routeHangs ? never<DurableMediaRoute>() : route,
    ),
    resolveSessionRoute: vi.fn(async () => (input.routeHangs ? never<DurableMediaRoute>() : route)),
    bindCarrierCallId: vi.fn(async () => ({ kind: 'alias' as const, route })),
    recordCarrierCallIdMismatch: vi.fn(async () => undefined),
  };
  const link: WorkerLink = { bufferedBytes: 0, send: () => undefined, close: vi.fn() };
  new SessionBridge({
    accepted: {
      socket: socket as unknown as WebSocket,
      ingress,
      bindingId: 'env',
      params: {},
      codec: ingress.serializer.createSession({}),
    },
    resolver,
    dialer: { connect: vi.fn(async () => (input.dialHangs ? never<WorkerLink>() : link)) },
    handshakeTimeoutMs: 60,
    idleTimeoutMs: 60,
    onClosed: (reason, _identity, timings) => closed.push({ reason, timings }),
  });
  const start = () =>
    socket.receive(
      fixtureInboundFrame({
        type: 'start',
        carrierCallId: 'call',
        streamId: 'stream',
        format: MULAW_8K,
        routeParams: { sid: 'session', rt: 'route-token' },
      }),
    );
  return { closed, start };
}

describe('call-start timeouts name their step (OBS-9)', () => {
  it('blames the carrier only when it never sent its start frame', async () => {
    const h = bridge({});
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(h.closed[0]).toMatchObject({
      reason: 'error:timeout:carrier_start',
      timings: { phase: 'carrier_start', carrierStartMs: null, routeResolveMs: null },
    });
  });

  it('names a slow route lookup', async () => {
    const h = bridge({ routeHangs: true });
    h.start();
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(h.closed[0]!.reason).toBe('error:timeout:route_resolve');
    expect(h.closed[0]!.timings.carrierStartMs).toBeGreaterThanOrEqual(0);
  });

  it('names a slow worker dial with the route lookup time', async () => {
    const h = bridge({ dialHangs: true });
    h.start();
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(h.closed[0]).toMatchObject({
      reason: 'error:timeout:worker_dial',
      timings: { phase: 'worker_dial', workerDialMs: null },
    });
    expect(h.closed[0]!.timings.routeResolveMs).toBeGreaterThanOrEqual(0);
  });

  it('names idle media once the worker accepted', async () => {
    const h = bridge({});
    h.start();
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(h.closed[0]).toMatchObject({
      reason: 'error:timeout:media_idle',
      timings: { phase: 'accepted' },
    });
    expect(h.closed[0]!.timings.workerDialMs).toBeGreaterThanOrEqual(0);
  });
});

describe('gateway verbose health (OBS-12)', () => {
  const gateways: MediaGateway[] = [];
  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  });

  async function serve(token?: string) {
    const verbose = vi.fn(async () => ({ database: { ok: true } }));
    const gateway = new MediaGateway({} as MediaRouteResolver, {
      publicBaseUrl: 'https://voice.example.test',
      workerToken: 'worker-token',
      ingresses: [ingress],
      hostFor: () => {
        throw new Error('unused');
      },
      health: { token, verbose },
    });
    gateways.push(gateway);
    const { port } = await gateway.listen();
    return { base: `http://127.0.0.1:${port}`, verbose };
  }

  it('keeps /health as it was and serves live state only to the token', async () => {
    const { base, verbose } = await serve('health-token');
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ready: true, sessions: 0 });
    expect((await fetch(`${base}/health?verbose=1`)).status).toBe(401);
    const ok = await fetch(`${base}/health?verbose=1`, {
      headers: { authorization: 'Bearer health-token' },
    });
    expect(await ok.json()).toEqual({ ready: true, sessions: 0, live: { database: { ok: true } } });
    expect(verbose).toHaveBeenCalledOnce();
  });

  it('refuses verbose health without a configured token', async () => {
    const { base, verbose } = await serve();
    const response = await fetch(`${base}/health?verbose=1`, {
      headers: { authorization: 'Bearer ' },
    });
    expect(response.status).toBe(403);
    expect(verbose).not.toHaveBeenCalled();
  });
});
