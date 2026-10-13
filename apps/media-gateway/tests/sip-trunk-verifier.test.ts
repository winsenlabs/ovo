import {
  Cap,
  type CarrierHttpRequest,
  type CarrierIngress,
  type SipRequestVerifier,
} from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { signedSipHttpRequest } from '@winsendotai/ovo-sip-carrier-kit/testing';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DISTRIBUTION_DEFAULTS } from '@winsendotai/ovo-distribution';
import { tcnCarrierPlugin } from '@winsendotai/ovo-plugin-carrier-tcn';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeCarrierHostPorts } from '../../../packages/conformance/src/drivers/carrier-host-ports.ts';
import { sipGatewayKey, sipTrunkVerifierPlugins } from '../src/sip-trunk-verifier.ts';
import { startGateway } from '../src/startup.ts';

const KEY = Buffer.alloc(32, 9);
const PREVIOUS = Buffer.alloc(32, 8);
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const inboundBody = {
  v: 1,
  callId: 'call-1@203.0.113.5',
  trunkId: 'tcn-sg',
  from: '+919876543210',
  to: '+918041234567',
  receivedAt: '2026-10-13T10:00:00.000Z',
  headers: {},
  sip: { requestUri: 'sip:+918041234567@203.0.113.10', fromUri: 'sip:x@203.0.113.5' },
  retry: 0,
};
const signed = (carrierId: string, key: Uint8Array): Promise<CarrierHttpRequest> =>
  signedSipHttpRequest({
    key,
    carrierId,
    bindingId: 'b1',
    purpose: 'inbound',
    body: inboundBody,
    now: Date.now(),
  });

async function composeWith(env: Record<string, string | undefined>) {
  let lookup: () => SipRequestVerifier | undefined = () => undefined;
  const consumer = definePlugin(
    {
      id: 'sip-verifier-consumer',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'process',
      kind: 'infra',
      provides: [],
      requires: [],
      optional: [Cap.sipTrunkVerifier],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      lookup = () => ctx.maybe(Cap.sipTrunkVerifier);
    },
  );
  const hosts = sipTrunkVerifierPlugins(env);
  const graph = await compose(
    [...hosts.map((plugin) => ({ id: plugin.manifest.id })), { id: consumer.manifest.id }],
    [...hosts, consumer],
    { scope: 'process' },
  );
  closers.push(() => graph.dispose());
  return () => lookup();
}

describe('gateway Cap.sipTrunkVerifier (Wave 11)', () => {
  it.each([undefined, '', 'false'])('is not composed when OVO_SIP_ENABLED is %j', async (flag) => {
    const verifier = await composeWith({
      OVO_SIP_ENABLED: flag,
      OVO_SIP_GATEWAY_SECRET: KEY.toString('base64'),
    });
    expect(verifier()).toBeUndefined();
  });

  it('verifies with the current key and, while rotating, the previous one', async () => {
    const verifier = await composeWith({
      OVO_SIP_ENABLED: 'true',
      OVO_SIP_GATEWAY_SECRET: KEY.toString('base64'),
      OVO_SIP_GATEWAY_SECRET_PREVIOUS: PREVIOUS.toString('base64url'),
    });
    const check = async (key: Uint8Array) => {
      const request = await signed('tcn', key);
      return verifier()!.verify({
        method: 'POST',
        externalUrl: request.externalUrl,
        headers: request.headers,
        body: request.rawBody,
      });
    };
    expect(await check(KEY)).toBe(true);
    expect(await check(PREVIOUS)).toBe(true);
    expect(await check(Buffer.alloc(32, 1))).toBe(false);
  });

  it('refuses to start enabled without a usable secret', () => {
    expect(() => sipTrunkVerifierPlugins({ OVO_SIP_ENABLED: 'true' })).toThrow(
      'OVO_SIP_GATEWAY_SECRET is required when OVO_SIP_ENABLED=true',
    );
    for (const secret of [
      'replace-with-base64-32-byte-key',
      Buffer.alloc(31, 1).toString('base64'),
      `${KEY.toString('base64')}!`,
    ])
      expect(() =>
        sipTrunkVerifierPlugins({ OVO_SIP_ENABLED: 'true', OVO_SIP_GATEWAY_SECRET: secret }),
      ).toThrow('OVO_SIP_GATEWAY_SECRET must be base64 of at least 32 bytes');
    expect(() =>
      sipTrunkVerifierPlugins({
        OVO_SIP_ENABLED: 'true',
        OVO_SIP_GATEWAY_SECRET: KEY.toString('base64'),
        OVO_SIP_GATEWAY_SECRET_PREVIOUS: 'short',
      }),
    ).toThrow('OVO_SIP_GATEWAY_SECRET_PREVIOUS must be base64 of at least 32 bytes');
  });

  it('decodes base64 and base64url keys alike', () => {
    expect(sipGatewayKey('K', KEY.toString('base64'))).toEqual(new Uint8Array(KEY));
    expect(sipGatewayKey('K', ` ${KEY.toString('base64url')}\n`)).toEqual(new Uint8Array(KEY));
  });

  it('stops gateway startup before it touches the database', async () => {
    await expect(
      startGateway({
        env: {
          DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
          OVO_MEDIA_PUBLIC_BASE_URL: 'https://voice.example.test',
          OVO_INBOUND_ROUTE_SECRET: 'fixture-route-secret-32-bytes-long',
          OVO_MEDIA_WORKER_TOKEN: 'fixture-worker-token',
          OVO_ORGANIZATION_ID: 'fixture-org',
          OVO_SIP_ENABLED: 'true',
        },
      }),
    ).rejects.toThrow('OVO_SIP_GATEWAY_SECRET is required when OVO_SIP_ENABLED=true');
  });
});

describe('gateway composition of the installed SIP carriers (Wave 11)', () => {
  async function ingress(env: Record<string, string>) {
    const distribution = await loadDistribution({
      role: 'gateway',
      profile: 'compose',
      env: {},
      log: () => undefined,
    });
    const hosts = sipTrunkVerifierPlugins(env);
    const graph = await compose(
      [
        ...hosts.map((plugin) => ({ id: plugin.manifest.id })),
        { id: '@winsendotai/ovo-carrier-sip' },
        { id: '@winsendotai/ovo-carrier-tcn' },
      ],
      [...distribution.catalog, ...hosts],
      { scope: 'process' },
    );
    closers.push(() => graph.dispose());
    return (provider: string) => graph.all(Cap.carrierIngress).get(provider) as CarrierIngress;
  }

  const host = (pluginId: string) =>
    createFakeCarrierHostPorts({
      bindings: {
        b1: {
          bindingId: 'b1',
          pluginId,
          workspaceId: 'w1',
          config: { trunkId: 'tcn-sg' },
          secret: '',
        },
      },
    });
  const inbound = (carriers: (provider: string) => CarrierIngress, provider: string) =>
    carriers(provider).routes.find((route) => route.purpose === 'inbound')!;

  it('admits a signed sip-gateway request on both carriers when enabled', async () => {
    const carriers = await ingress({
      OVO_SIP_ENABLED: 'true',
      OVO_SIP_GATEWAY_SECRET: KEY.toString('base64'),
    });
    for (const [provider, pluginId] of [
      ['tcn', '@winsendotai/ovo-carrier-tcn'],
      ['sip', '@winsendotai/ovo-carrier-sip'],
    ] as const) {
      const reply = await inbound(carriers, provider).handle(
        await signed(provider, KEY),
        host(pluginId),
      );
      expect(reply.status, provider).toBe(200);
      expect(JSON.parse(String(reply.body))).toMatchObject({ kind: 'connect' });
    }
  });

  it('answers 503 on both carriers while SIP is off, even for a correctly signed request', async () => {
    const carriers = await ingress({
      OVO_SIP_ENABLED: 'false',
      OVO_SIP_GATEWAY_SECRET: KEY.toString('base64'),
    });
    for (const provider of ['tcn', 'sip']) {
      const ports = host(`@winsendotai/ovo-carrier-${provider}`);
      const reply = await inbound(carriers, provider).handle(await signed(provider, KEY), ports);
      expect(reply.status).toBe(503);
      expect(ports.calls.filter((call) => call.method === 'admitInbound')).toEqual([]);
    }
  });
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('gateway startup with the SIP flag (Wave 11)', () => {
  async function freePort() {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it.each([
    ['on', 'true', 401, true],
    ['off', 'false', 503, false],
  ] as const)(
    'with SIP %s, the tcn routes answer an unsigned request %i',
    async (_label, flag, status, composed) => {
      const port = await freePort();
      const runtime = await startGateway({
        distribution: {
          catalog: [tcnCarrierPlugin],
          processRows: [{ id: tcnCarrierPlugin.manifest.id }],
          defaults: DISTRIBUTION_DEFAULTS,
          fixtures: {},
          fixtureTemplates: {},
          unavailable: [],
        },
        env: {
          DATABASE_URL: postgresUrl,
          OVO_ORGANIZATION_ID: `gateway-sip-${flag}`,
          OVO_MEDIA_PUBLIC_BASE_URL: 'https://voice.example.test',
          OVO_MEDIA_WORKER_TOKEN: 'fixture-worker-token',
          OVO_INBOUND_ROUTE_SECRET: 'fixture-route-secret-32-bytes-long',
          OVO_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
          OVO_MEDIA_HOST: '127.0.0.1',
          OVO_MEDIA_PORT: String(port),
          OVO_SIP_ENABLED: flag,
          OVO_SIP_GATEWAY_SECRET: KEY.toString('base64'),
        },
      });
      closers.push(() => runtime.close());
      expect(runtime.composition.get(Cap.sipTrunkVerifier) !== undefined).toBe(composed);
      const response = await fetch(`http://127.0.0.1:${port}/carriers/tcn/b1/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inboundBody),
      });
      expect(response.status).toBe(status);
    },
  );
});
