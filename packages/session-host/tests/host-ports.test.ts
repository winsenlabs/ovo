import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCarrierHostPorts } from '../src/host-ports.ts';

const SECRET = 'a'.repeat(32);
function fixture() {
  const route = {
    sessionId: 'session',
    organizationId: 'w',
    dialRequestId: 'dial',
    carrierId: 'carrier',
    bindingId: 'binding',
    carrierCallId: undefined as string | undefined,
    carrierStreamCallId: undefined as string | undefined,
    status: 'accepted',
  };
  const resolveSessionRoute = vi.fn(
    async (query: {
      organizationId: string;
      carrierId: string;
      dialRequestId?: string;
      carrierRequestId?: string;
      carrierCallId?: string;
    }) => {
      if (query.organizationId !== route.organizationId || query.carrierId !== route.carrierId)
        return undefined;
      if (query.dialRequestId && query.dialRequestId !== route.dialRequestId) return undefined;
      if (query.carrierRequestId) return undefined;
      if (query.carrierCallId) {
        if (!query.dialRequestId && query.carrierCallId !== route.carrierCallId) return undefined;
      }
      return { ...route };
    },
  );
  const issueStreamGrant = vi.fn(
    async (input: { carrierCallId?: string; tokenHash: string; expiresAt: Date }) => {
      if (input.carrierCallId) {
        if (!route.carrierCallId) route.carrierCallId = input.carrierCallId;
        else if (route.carrierCallId !== input.carrierCallId)
          route.carrierStreamCallId = input.carrierCallId;
      }
      return { ...route };
    },
  );
  const reissueStream = vi.fn(async () => ({ ...route, status: 'connected' }));
  const orchestration = {
    resolveSessionRoute,
    issueStreamGrant,
    reissueStream,
    recordCarrierCallIdMismatch: vi.fn(async () => undefined),
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
    expect(
      await ports.streamForDial({ ...query, dialRequestId: 'unknown', carrierCallId: undefined }),
    ).toEqual({ kind: 'unmatched' });
    expect(orchestration.issueStreamGrant).not.toHaveBeenCalled();
    const granted = await ports.streamForDial(query);
    expect(granted.kind).toBe('stream');
    if (granted.kind !== 'stream') return;
    const raw = granted.routeParams.rt;
    expect(Buffer.from(raw, 'base64url').length).toBe(32);
    expect(orchestration.issueStreamGrant.mock.calls[0]?.[0]).toMatchObject({
      organizationId: 'w',
      carrierId: 'carrier',
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(160_000),
    });
    expect(granted.routeParams.sid).toBe('session');
    expect(granted.resumeUrl).toContain('r=dial');
    expect(await ports.streamForDial({ ...query, dialRequestId: 'wrong' })).toEqual({
      kind: 'unmatched',
    });
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
      expect.objectContaining({
        workerFreshSeconds: 30,
        organizationId: 'w',
        carrierId: 'carrier',
      }),
    );
  });
  it('records differing dial and stream call IDs only for carriers that allow aliases', async () => {
    const { orchestration, operations, route } = fixture();
    const bindings = vi.fn(async () => ({
      bindingId: 'binding',
      pluginId: 'carrier',
      workspaceId: 'w',
      config: {},
      secret: 's',
    }));
    route.carrierCallId = 'dial-call';
    const options = {
      publicBaseUrl: 'https://example.test',
      routeSecret: SECRET,
      orchestration,
      operations,
      bindings,
    };
    const query = {
      carrierId: 'carrier',
      bindingId: 'binding',
      dialRequestId: 'dial',
      carrierCallId: 'stream-call',
    };
    const aliasHost = createCarrierHostPorts({ ...options, streamCallIdMatchesDial: () => false });
    expect((await aliasHost.streamForDial(query)).kind).toBe('stream');
    expect(orchestration.recordCarrierCallIdMismatch).toHaveBeenCalledWith({
      sessionId: 'session',
      organizationId: 'w',
      carrierId: 'carrier',
      dialCallId: 'dial-call',
      streamCallId: 'stream-call',
    });
    expect(bindings).toHaveBeenCalledWith('binding', 'carrier');
  });
  it('rejects a mismatched stream id for an exact-id carrier before issuing a grant', async () => {
    const { orchestration, operations, route } = fixture();
    route.carrierCallId = 'dial-call';
    const exactHost = createCarrierHostPorts({
      publicBaseUrl: 'https://example.test',
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
      streamCallIdMatchesDial: () => true,
    });
    expect(
      await exactHost.streamForDial({
        carrierId: 'carrier',
        bindingId: 'binding',
        dialRequestId: 'dial',
        carrierCallId: 'stream-call',
      }),
    ).toEqual({ kind: 'unmatched' });
    expect(orchestration.issueStreamGrant).not.toHaveBeenCalled();
    expect(orchestration.recordCarrierCallIdMismatch).not.toHaveBeenCalled();
    expect(
      (
        await exactHost.streamForDial({
          carrierId: 'carrier',
          bindingId: 'binding',
          dialRequestId: 'dial',
          carrierCallId: 'dial-call',
        })
      ).kind,
    ).toBe('stream');
    expect(orchestration.issueStreamGrant).toHaveBeenCalledWith(
      expect.objectContaining({ streamCallIdMatchesDial: true }),
    );
  });
  it('audits an alias when the primary id appeared after the initial route read', async () => {
    const { orchestration, operations, route } = fixture();
    orchestration.issueStreamGrant.mockResolvedValueOnce({
      ...route,
      carrierCallId: 'dial-call',
      carrierStreamCallId: 'stream-call',
    });
    const aliasHost = createCarrierHostPorts({
      publicBaseUrl: 'https://example.test',
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
      streamCallIdMatchesDial: () => false,
    });
    expect(
      (
        await aliasHost.streamForDial({
          carrierId: 'carrier',
          bindingId: 'binding',
          dialRequestId: 'dial',
          carrierCallId: 'stream-call',
        })
      ).kind,
    ).toBe('stream');
    expect(orchestration.recordCarrierCallIdMismatch).toHaveBeenCalledWith({
      sessionId: 'session',
      organizationId: 'w',
      carrierId: 'carrier',
      dialCallId: 'dial-call',
      streamCallId: 'stream-call',
    });
  });
  it('fails closed when a carrier binding has no workspace scope', async () => {
    const { orchestration, operations } = fixture();
    const ports = createCarrierHostPorts({
      publicBaseUrl: 'https://example.test',
      routeSecret: SECRET,
      orchestration,
      operations,
      bindings: vi.fn(async () => ({
        bindingId: 'binding',
        pluginId: 'carrier',
        workspaceId: '',
        config: {},
        secret: 's',
      })),
    });
    expect(
      await ports.streamForDial({
        carrierId: 'carrier',
        bindingId: 'binding',
        dialRequestId: 'dial',
      }),
    ).toEqual({ kind: 'unmatched' });
    expect(orchestration.resolveSessionRoute).not.toHaveBeenCalled();
    expect(
      await ports.resumeStream({
        carrierId: 'carrier',
        bindingId: 'binding',
        carrierCallId: 'call',
      }),
    ).toEqual({ kind: 'ended' });
    expect(orchestration.reissueStream).not.toHaveBeenCalled();
  });
  it('uses the resolved binding workspace on each carrier lookup', async () => {
    const { orchestration, operations } = fixture();
    const bindings = vi.fn(async (id: string) => ({
      bindingId: id,
      pluginId: 'carrier',
      workspaceId: id === 'binding' ? 'w' : 'other-workspace',
      config: {},
      secret: 's',
    }));
    const ports = createCarrierHostPorts({
      publicBaseUrl: 'https://example.test',
      routeSecret: SECRET,
      orchestration,
      operations,
      bindings,
    });
    expect(
      (
        await ports.streamForDial({
          carrierId: 'carrier',
          bindingId: 'binding',
          dialRequestId: 'dial',
        })
      ).kind,
    ).toBe('stream');
    expect(
      await ports.streamForDial({
        carrierId: 'carrier',
        bindingId: 'other',
        dialRequestId: 'dial',
      }),
    ).toEqual({ kind: 'unmatched' });
    expect(orchestration.resolveSessionRoute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ organizationId: 'w', carrierId: 'carrier' }),
    );
    expect(orchestration.resolveSessionRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ organizationId: 'other-workspace', carrierId: 'carrier' }),
    );
    expect(bindings).toHaveBeenNthCalledWith(1, 'binding', 'carrier');
    expect(bindings).toHaveBeenNthCalledWith(2, 'other', 'carrier');
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
    const requestRoute = {
      sessionId: 'session',
      organizationId: 'w',
      carrierId: 'carrier',
      bindingId: 'binding',
      status: 'accepted',
    };
    orchestration.resolveSessionRoute.mockImplementationOnce(async (query) =>
      query.organizationId === 'w' &&
      query.carrierId === 'carrier' &&
      query.carrierRequestId === 'request'
        ? (requestRoute as never)
        : undefined,
    );
    orchestration.issueStreamGrant.mockResolvedValueOnce({
      ...requestRoute,
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
