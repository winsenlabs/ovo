import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCarrierHostPorts } from '../src/host-ports.ts';
import { terminateCarrierLeg } from '../src/terminate.ts';

const SECRET = 'a'.repeat(32);
function fixture() {
  const route = {
    sessionId: 'session',
    dialRequestId: 'dial',
    carrierId: 'carrier',
    bindingId: 'binding',
    status: 'accepted',
  };
  const resolveSessionRoute = vi.fn(async () => route);
  const issueStreamGrant = vi.fn(async (_input: { tokenHash: string; expiresAt: Date }) => route);
  const reissueStream = vi.fn(async () => ({ ...route, status: 'connected' }));
  const orchestration = {
    resolveSessionRoute,
    issueStreamGrant,
    reissueStream,
    applyCallEvent: vi.fn(async () => ({ kind: 'applied' as const })),
  };
  const operations = {
    admitInbound: vi.fn(async () => ({ kind: 'hangup' as const })),
    confirmCallback: vi.fn(async () => ({ kind: 'hangup' as const })),
  };
  const ports = createCarrierHostPorts({
    publicBaseUrl: 'https://example.test:9443/prefix',
    routeSecret: SECRET,
    orchestration,
    operations,
    bindings: vi.fn(async () => ({
      bindingId: 'binding',
      pluginId: 'carrier',
      workspaceId: 'w',
      config: {},
      secret: 's',
    })),
    clock: { now: () => 100_000 },
  });
  return { route, ports, orchestration, operations };
}
function request(url: string) {
  const parsed = new URL(url);
  return {
    method: 'POST' as const,
    externalUrl: url,
    query: Object.fromEntries(parsed.searchParams),
    headers: {},
    rawBody: new Uint8Array(),
    bindingId: 'binding',
  };
}

describe('carrier host ports', () => {
  it('rejects insecure bases, short secrets and unauthorized media query', () => {
    const { orchestration, operations } = fixture();
    const minimal = { orchestration, operations, bindings: vi.fn(), routeSecret: SECRET };
    expect(() =>
      createCarrierHostPorts({ ...minimal, publicBaseUrl: 'http://example.test' }),
    ).toThrow('https');
    expect(() =>
      createCarrierHostPorts({
        ...minimal,
        publicBaseUrl: 'https://example.test',
        routeSecret: 'short',
      }),
    ).toThrow('32 bytes');
    expect(() =>
      fixture().ports.mediaUrl('carrier', 'binding', { query: { sid: 'secret' } }),
    ).toThrow('does not permit');
  });
  it('builds wss media with an explicit port and authenticates per-call callback URLs', () => {
    const { ports } = fixture();
    expect(ports.mediaUrl('carrier', 'binding')).toBe(
      'wss://example.test:9443/carriers/carrier/binding/media',
    );
    const url = ports.callbackUrl('carrier', 'binding', 'status', { requestId: 'dial' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('r')).toBe('dial');
    expect(parsed.searchParams.get('t')).toBe(
      createHmac('sha256', SECRET).update('carrier:binding:status:dial').digest('hex'),
    );
    expect(ports.verifyUrlSecret(request(url), { purpose: 'status', requestId: 'dial' })).toBe(
      true,
    );
    for (const invalid of [
      url.replace('dial', 'other'),
      url.replace('example.test', 'evil.test'),
      url.replace('https:', 'http:'),
      url.replace('t=', 't=x'),
    ])
      expect(
        ports.verifyUrlSecret(request(invalid), { purpose: 'status', requestId: 'dial' }),
      ).toBe(false);
  });
  it('mints hashed single-use grants and fences mismatched carrier before mutation', async () => {
    const { ports, orchestration } = fixture();
    const query = {
      carrierId: 'carrier',
      bindingId: 'binding',
      dialRequestId: 'dial',
      carrierCallId: 'call',
    };
    expect(await ports.streamForDial({ ...query, carrierId: 'other' })).toEqual({
      kind: 'unmatched',
    });
    expect(orchestration.issueStreamGrant).not.toHaveBeenCalled();
    const granted = await ports.streamForDial(query);
    expect(granted.kind).toBe('stream');
    if (granted.kind !== 'stream') return;
    const raw = granted.routeParams.rt;
    expect(Buffer.from(raw, 'base64url').length).toBe(32);
    expect(orchestration.issueStreamGrant.mock.calls[0]?.[0]).toMatchObject({
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(160_000),
    });
    expect(granted.routeParams.sid).toBe('session');
    expect(granted.resumeUrl).toContain('r=dial');
    expect(
      await ports.resumeStream({ carrierId: 'other', bindingId: 'binding', carrierCallId: 'call' }),
    ).toEqual({ kind: 'ended' });
    expect(orchestration.reissueStream).not.toHaveBeenCalled();
    const resumed = await ports.resumeStream({
      carrierId: 'carrier',
      bindingId: 'binding',
      carrierCallId: 'call',
    });
    expect(resumed.kind).toBe('stream');
    expect(orchestration.reissueStream).toHaveBeenCalledWith(
      expect.objectContaining({ workerFreshSeconds: 30 }),
    );
  });
  it('builds callback URLs when only a carrier request id is available and scopes env lookup', async () => {
    const { orchestration, operations } = fixture();
    const bindings = vi.fn(async (_id: string, _carrierId?: string) => ({
      bindingId: 'env',
      pluginId: 'carrier',
      workspaceId: 'w',
      config: {},
      secret: 's',
    }));
    const ports = createCarrierHostPorts({
      publicBaseUrl: 'https://example.test',
      routeSecret: SECRET,
      orchestration,
      operations,
      bindings,
      carrierId: 'carrier',
    });
    await ports.resolveBinding('env');
    expect(bindings).toHaveBeenCalledWith('env', 'carrier');
    orchestration.resolveSessionRoute.mockResolvedValueOnce({
      sessionId: 'session',
      carrierId: 'carrier',
      bindingId: 'binding',
      status: 'accepted',
    } as never);
    orchestration.issueStreamGrant.mockResolvedValueOnce({
      sessionId: 'session',
      carrierId: 'carrier',
      bindingId: 'binding',
      status: 'accepted',
    } as never);
    const grant = await ports.streamForDial({
      carrierId: 'carrier',
      bindingId: 'binding',
      carrierRequestId: 'request',
    });
    expect(grant.kind).toBe('stream');
    if (grant.kind === 'stream') expect(grant.resumeUrl).toContain('r=request');
  });
  it('delegates inbound admission and call events without altering them', async () => {
    const { ports, operations, orchestration } = fixture();
    const admission = {
      carrierId: 'carrier',
      bindingId: 'binding',
      carrierCallId: 'call',
      from: '+1',
      to: '+2',
      receivedAt: new Date(),
    };
    await ports.admitInbound(admission);
    expect(operations.admitInbound).toHaveBeenCalledWith(admission);
    const event = {
      carrierId: 'carrier',
      bindingId: 'binding',
      eventId: 'e',
      state: 'ringing' as const,
      occurredAt: new Date(),
    };
    await ports.applyCallEvent(event);
    expect(orchestration.applyCallEvent).toHaveBeenCalledWith(event);
  });
});

describe('carrier leg termination', () => {
  it('fences, hangs up, then disposes in documented order', async () => {
    const order: string[] = [];
    const base = {
      route: { sessionId: 'session', carrierCallId: 'call' },
      store: {
        requestSessionTermination: async () => {
          order.push('fence');
        },
      },
      control: {
        hangup: async () => {
          order.push('hangup');
          return 'ended';
        },
      },
      media: {
        terminate: async () => {
          order.push('media');
        },
      },
      engine: {
        dispose: async () => {
          order.push('dispose');
          return { reason: 'completed', outcome: 'completed' };
        },
      },
      capabilities: { control: { hangup: 'rest' } },
      reason: 'completed',
    };
    await terminateCarrierLeg(base as never);
    expect(order).toEqual(['fence', 'hangup', 'dispose']);
    order.length = 0;
    await terminateCarrierLeg({
      ...base,
      control: {
        hangup: async () => {
          order.push('hangup');
          return 'unsupported';
        },
      },
      capabilities: { control: { hangup: 'close-stream' } },
    } as never);
    expect(order).toEqual(['fence', 'hangup', 'media', 'dispose']);
  });
});
