import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import {
  fixtureCarrierIngress,
  fixtureInboundFrame,
} from '../../conformance/src/drivers/fixture-carrier.ts';
import type {
  DurableMediaRoute,
  GatewayToWorkerMessage,
  MediaRouteResolver,
} from '../src/ports.ts';
import { SessionBridge, type SessionBridgeOptions } from '../src/session-bridge.ts';
import { PreAcceptBuffer } from '../src/pre-accept.ts';
import { createMediaGatewayPlugin } from '../src/plugin.ts';
import type { WorkerLink, WorkerLinkEvents } from '../src/worker-dialer.ts';

class CarrierSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  frames: string[] = [];
  closeReason?: string;

  send(frame: string): void {
    this.frames.push(frame);
  }
  close(_code?: number, reason?: string): void {
    if (reason && Buffer.byteLength(reason, 'utf8') > 123)
      throw new RangeError('WebSocket close reason exceeds 123 bytes');
    this.closeReason = reason;
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

it('buffers three full seconds of audio plus DTMF and rejects the next audio frame', () => {
  const buffer = new PreAcceptBuffer<{ type: string }>(MULAW_8K);
  for (let frame = 0; frame < 150; frame += 1)
    expect(buffer.push({ type: 'audio' }, 160)).toBe(true);
  expect(buffer.bufferedAudioBytes).toBe(24_000);
  expect(buffer.push({ type: 'dtmf' })).toBe(true);
  expect(buffer.push({ type: 'audio' }, 160)).toBe(false);
  expect(buffer.drain()).toHaveLength(151);
});

it('refuses a pre-accept budget that cannot hold the first 8 kHz audio frame', () => {
  expect(() => new PreAcceptBuffer(MULAW_8K, 19)).toThrow('at least 20 ms');
  const buffer = new PreAcceptBuffer<{ type: string }>(MULAW_8K, 20);
  expect(buffer.push({ type: 'audio' }, 160)).toBe(true);
  expect(buffer.push({ type: 'audio' }, 1)).toBe(false);
  const plugin = createMediaGatewayPlugin(
    { workerToken: 'synthetic' },
    {
      hostFor: () => {
        throw new Error('unused');
      },
    },
  );
  const properties = plugin.manifest.configSchema.properties as Record<
    string,
    { minimum?: number }
  >;
  expect(properties.preAcceptBufferMs?.minimum).toBe(20);
});

const ingress = fixtureCarrierIngress();
function route(overrides: Partial<DurableMediaRoute> = {}): DurableMediaRoute {
  return {
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
    ...overrides,
  };
}

function harness(
  options: {
    route?: DurableMediaRoute;
    accept?: boolean;
    ingress?: typeof ingress;
    codec?: SessionBridgeOptions['accepted']['codec'];
    resolver?: Partial<MediaRouteResolver>;
  } = {},
) {
  const socket = new CarrierSocket();
  const selected = options.route ?? route();
  const sent: GatewayToWorkerMessage[] = [];
  const resolver: MediaRouteResolver = {
    authenticateSessionRoute: vi.fn(async () => selected),
    resolveSessionRoute: vi.fn(async () => selected),
    bindCarrierCallId: vi.fn(async ({ carrierCallId }) => ({
      kind: 'alias' as const,
      route: { ...selected, carrierStreamCallId: carrierCallId },
    })),
    recordCarrierCallIdMismatch: vi.fn(async () => undefined),
    ...options.resolver,
  };
  let callbacks: WorkerLinkEvents | undefined;
  let admit: ((link: WorkerLink) => void) | undefined;
  const link: WorkerLink = {
    bufferedBytes: 0,
    send: (message) => sent.push(message),
    close: vi.fn(),
  };
  const dialer = {
    connect: vi.fn(
      async (
        _route: DurableMediaRoute,
        open: Extract<GatewayToWorkerMessage, { type: 'session.open' }>,
        events: WorkerLinkEvents,
      ) => {
        sent.push(open);
        callbacks = events;
        if (options.accept) return link;
        return new Promise<WorkerLink>((resolve) => {
          admit = resolve;
        });
      },
    ),
  };
  const bridge = new SessionBridge({
    accepted: {
      socket: socket as unknown as WebSocket,
      ingress: options.ingress ?? ingress,
      bindingId: 'env',
      params: {},
      codec: options.codec ?? ingress.serializer.createSession({}),
    },
    resolver,
    dialer,
    handshakeTimeoutMs: 1_000,
  });
  const start = (carrierCallId = 'call') =>
    socket.receive(
      fixtureInboundFrame({
        type: 'start',
        carrierCallId,
        streamId: 'stream',
        format: MULAW_8K,
        routeParams: { sid: 'session', rt: 'route-token' },
      }),
    );
  return {
    socket,
    sent,
    resolver,
    dialer,
    bridge,
    start,
    accept: () => admit?.(link),
    worker: (message: Parameters<WorkerLinkEvents['onMessage']>[0]) =>
      callbacks?.onMessage(message),
    disconnect: () => callbacks?.onClose('worker disconnected'),
  };
}

it('buffers media, DTMF and played evidence in arrival order until the worker accepts', async () => {
  const h = harness();
  h.start();
  await vi.waitFor(() => expect(h.dialer.connect).toHaveBeenCalledOnce());
  h.socket.receive(
    fixtureInboundFrame({ type: 'audio', seq: 1, timestampMs: 7, payload: new Uint8Array([1, 2]) }),
  );
  h.socket.receive(fixtureInboundFrame({ type: 'dtmf', digit: '5' }));
  h.socket.receive(fixtureInboundFrame({ type: 'played', name: 'mark-1' }));
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({
    type: 'session.open',
    protocol: 2,
    routeToken: 'route-token',
    carrierId: 'fixture',
    bindingId: 'env',
    carrierCallId: 'call',
    ownerEpoch: 2,
    generation: 3,
  });
  h.accept();
  await vi.waitFor(() => expect(h.sent).toHaveLength(4));
  expect(h.sent.slice(1)).toEqual([
    { type: 'media.audio', payload: 'AQI=', sequenceNumber: 1, timestampMs: 7 },
    { type: 'media.dtmf', digit: '5' },
    { type: 'media.played', name: 'mark-1', evidence: 'carrier-played' },
  ]);
  h.bridge.close();
});

it('refuses a terminal route before dialing a worker or forwarding audio', async () => {
  const h = harness({ route: route({ status: 'terminating' }) });
  h.start();
  h.socket.receive(
    fixtureInboundFrame({ type: 'audio', seq: 1, timestampMs: 0, payload: new Uint8Array([1]) }),
  );
  await vi.waitFor(() => expect(h.bridge.isClosed).toBe(true));
  expect(h.dialer.connect).not.toHaveBeenCalled();
  expect(h.sent).toEqual([]);
  expect(h.socket.closeReason).toContain('no live authenticated durable session route');
});

it('refuses an authenticated route returned for a different session ID', async () => {
  const h = harness({ route: route({ sessionId: 'other' }) });
  h.start();
  await vi.waitFor(() => expect(h.bridge.isClosed).toBe(true));
  expect(h.dialer.connect).not.toHaveBeenCalled();
  expect(h.socket.closeReason).toContain('route ID does not match');
});

it('rejects a mismatched call ID when the carrier guarantees dial and stream IDs match', async () => {
  const h = harness();
  h.start('other-call');
  await vi.waitFor(() => expect(h.bridge.isClosed).toBe(true));
  expect(h.resolver.bindCarrierCallId).not.toHaveBeenCalled();
  expect(h.dialer.connect).not.toHaveBeenCalled();
  expect(h.socket.closeReason).toContain('does not match dial call ID');
});

it('binds and audits a permitted stream-call alias before worker dial', async () => {
  const aliasIngress = {
    ...ingress,
    capabilities: {
      ...ingress.capabilities,
      control: { ...ingress.capabilities.control, streamCallIdMatchesDial: false },
    },
  };
  const h = harness({
    ingress: aliasIngress,
    route: route({ carrierStreamCallId: 'other-call' }),
    resolver: {
      bindCarrierCallId: vi.fn(async () => ({
        kind: 'alias' as const,
        route: route({ carrierStreamCallId: 'other-call' }),
      })),
    },
  });
  h.start('other-call');
  await vi.waitFor(() => expect(h.dialer.connect).toHaveBeenCalledOnce());
  // The durable audit is idempotent, so an already bound alias must still be checked.
  expect(h.resolver.bindCarrierCallId).not.toHaveBeenCalled();
  expect(h.resolver.recordCarrierCallIdMismatch).toHaveBeenCalledWith({
    sessionId: 'session',
    organizationId: 'org',
    carrierId: 'fixture',
    dialCallId: 'call',
    streamCallId: 'other-call',
  });
  h.bridge.close();

  const fresh = harness({ ingress: aliasIngress });
  fresh.start('other-call');
  await vi.waitFor(() => expect(fresh.dialer.connect).toHaveBeenCalledOnce());
  expect(fresh.resolver.bindCarrierCallId).toHaveBeenCalledWith({
    organizationId: 'org',
    carrierId: 'fixture',
    sessionId: 'session',
    carrierCallId: 'other-call',
  });
  expect(fresh.resolver.recordCarrierCallIdMismatch).toHaveBeenCalledWith({
    sessionId: 'session',
    organizationId: 'org',
    carrierId: 'fixture',
    dialCallId: 'call',
    streamCallId: 'other-call',
  });
  fresh.bridge.close();
});

it('refuses a binder result that fails to persist the alias or changes ownership', async () => {
  const aliasIngress = {
    ...ingress,
    capabilities: {
      ...ingress.capabilities,
      control: { ...ingress.capabilities.control, streamCallIdMatchesDial: false },
    },
  };
  for (const unsafe of [
    route(),
    route({ workerId: 'another-worker', carrierStreamCallId: 'other-call' }),
  ]) {
    const h = harness({
      ingress: aliasIngress,
      resolver: {
        bindCarrierCallId: vi.fn(async () => ({ kind: 'alias' as const, route: unsafe })),
      },
    });
    h.start('other-call');
    await vi.waitFor(() => expect(h.bridge.isClosed).toBe(true));
    expect(h.dialer.connect).not.toHaveBeenCalled();
  }
});

it('sends serializer termination before closing the carrier and closes on worker disconnect', async () => {
  const base = ingress.serializer.createSession({});
  const codec = {
    decode: (raw: string) => base.decode(raw),
    encode: (command: Parameters<typeof base.encode>[0]) => base.encode(command),
    flush: () => ['flush-frame'],
    terminate: () => ['terminate-frame'],
  };
  const h = harness({ accept: true, codec });
  h.start();
  await vi.waitFor(() => expect(h.dialer.connect).toHaveBeenCalledOnce());
  h.worker({ type: 'session.end', reason: 'terminate' });
  expect(h.socket.frames).toEqual(['flush-frame', 'terminate-frame']);
  expect(h.bridge.isClosed).toBe(true);
  expect(h.sent).not.toContainEqual(expect.objectContaining({ type: 'session.close' }));

  const disconnect = harness({ accept: true });
  disconnect.start();
  await vi.waitFor(() => expect(disconnect.dialer.connect).toHaveBeenCalledOnce());
  disconnect.disconnect();
  expect(disconnect.bridge.isClosed).toBe(true);
  expect(disconnect.socket.closeReason).toContain('worker disconnected');
});

it('leaves the worker session resumable after an unexpected carrier socket loss', async () => {
  const first = harness({ accept: true });
  first.start();
  await vi.waitFor(() => expect(first.dialer.connect).toHaveBeenCalledOnce());
  first.socket.close(1006, 'connection lost');
  expect(first.bridge.isClosed).toBe(true);
  expect(first.sent).not.toContainEqual(expect.objectContaining({ type: 'session.close' }));

  const resumed = harness({ accept: true, route: route({ generation: 4, status: 'connected' }) });
  resumed.start();
  await vi.waitFor(() => expect(resumed.dialer.connect).toHaveBeenCalledOnce());
  expect(resumed.sent[0]).toMatchObject({ type: 'session.open', generation: 4 });
  resumed.bridge.close();
});

it('still finalizes the worker session when the carrier explicitly stops', async () => {
  const h = harness({ accept: true });
  h.start();
  await vi.waitFor(() => expect(h.dialer.connect).toHaveBeenCalledOnce());
  h.socket.receive(fixtureInboundFrame({ type: 'stop', reason: 'caller-hangup' }));
  expect(h.sent).toContainEqual({ type: 'session.close', reason: 'caller_hangup' });
});

// OBS-1: the bridge sent `carrier stream-ended`, which only a legacy mapping table kept from
// becoming `error:carrier stream-ended`. Every carrier stop reason now reaches the worker typed.
it.each(['stream-ended', 'caller-hangup', 'unknown'] as const)(
  'closes the worker session with the typed caller_hangup for a carrier %s stop',
  async (reason) => {
    const closed: string[] = [];
    const h = harness({ accept: true });
    h.bridge.close = new Proxy(h.bridge.close, {
      apply: (target, self, args: [string?, boolean?]) => {
        closed.push(args[0] ?? '');
        return Reflect.apply(target, self, args);
      },
    });
    h.start();
    await vi.waitFor(() => expect(h.dialer.connect).toHaveBeenCalledOnce());
    h.socket.receive(fixtureInboundFrame({ type: 'stop', reason }));
    expect(h.sent.filter((message) => message.type === 'session.close')).toEqual([
      { type: 'session.close', reason: 'caller_hangup' },
    ]);
    expect(closed[0]).toBe('caller_hangup');
  },
);

it('keeps the worker’s own end reason when the worker ended the call before the carrier stop', async () => {
  const h = harness({ accept: true });
  h.start();
  await vi.waitFor(() => expect(h.dialer.connect).toHaveBeenCalledOnce());
  h.worker({ type: 'session.end', reason: 'behavior_completed' });
  h.socket.receive(fixtureInboundFrame({ type: 'stop', reason: 'stream-ended' }));
  expect(h.sent).not.toContainEqual(expect.objectContaining({ type: 'session.close' }));
});
