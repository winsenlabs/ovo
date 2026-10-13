import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Cap,
  type CarrierControlFactory,
  type DialRequest,
  type SipTrunkControlClient,
} from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SIP_CONTROL_URL, sipTrunkControlPlugins } from '../src/sip-trunk-control.ts';

const TOKEN = 'c'.repeat(64);
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A stand-in sip-gateway control API on loopback that records what the worker sent. */
async function controlApi() {
  const seen: { method?: string; url?: string; authorization?: string; body: string }[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      request.url === '/v1/calls'
        ? JSON.stringify({ kind: 'accepted', carrierCallId: 'cid@ovo', carrierRequestId: 'req-1' })
        : JSON.stringify({ ready: true, draining: false, calls: 0, trunks: {} }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Composes the host plugins with a consumer that, like a carrier plugin, reads the key lazily. */
async function composeWith(env: Record<string, string | undefined>) {
  let lookup: () => SipTrunkControlClient | undefined = () => undefined;
  const consumer = definePlugin(
    {
      id: 'sip-control-consumer',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'process',
      kind: 'host',
      provides: [],
      requires: [],
      optional: [Cap.sipTrunkControl],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      lookup = () => ctx.maybe(Cap.sipTrunkControl);
    },
  );
  const hosts = sipTrunkControlPlugins(env);
  const graph = await compose(
    [...hosts.map((plugin) => ({ id: plugin.manifest.id })), { id: consumer.manifest.id }],
    [...hosts, consumer],
    { scope: 'process' },
  );
  closers.push(() => graph.dispose());
  return { graph, client: () => lookup() };
}

describe('worker Cap.sipTrunkControl (Wave 11)', () => {
  it.each([undefined, '', 'false', 'yes'])(
    'is not composed when OVO_SIP_ENABLED is %j, whatever else is set',
    async (flag) => {
      const { client } = await composeWith({
        OVO_SIP_ENABLED: flag,
        OVO_SIP_CONTROL_TOKEN: TOKEN,
        OVO_SIP_CONTROL_URL: 'http://127.0.0.1:1',
      });
      expect(client()).toBeUndefined();
    },
  );

  it('is composed when enabled and sends bearer-authenticated JSON to OVO_SIP_CONTROL_URL', async () => {
    const api = await controlApi();
    const { client } = await composeWith({
      OVO_SIP_ENABLED: 'true',
      OVO_SIP_CONTROL_TOKEN: TOKEN,
      OVO_SIP_CONTROL_URL: api.url,
    });
    expect(await client()!.request({ method: 'GET', path: '/v1/health' })).toEqual({
      status: 200,
      body: { ready: true, draining: false, calls: 0, trunks: {} },
    });
    expect(api.seen).toEqual([
      { method: 'GET', url: '/v1/health', authorization: `Bearer ${TOKEN}`, body: '' },
    ]);
  });

  it('refuses to start enabled without a control token', () => {
    expect(() => sipTrunkControlPlugins({ OVO_SIP_ENABLED: 'true' })).toThrow(
      'OVO_SIP_CONTROL_TOKEN is required when OVO_SIP_ENABLED=true',
    );
    expect(() =>
      sipTrunkControlPlugins({ OVO_SIP_ENABLED: 'true', OVO_SIP_CONTROL_TOKEN: '' }),
    ).toThrow('OVO_SIP_CONTROL_TOKEN is required');
    expect(() =>
      sipTrunkControlPlugins({ OVO_SIP_ENABLED: 'true', OVO_SIP_CONTROL_TOKEN: 'c'.repeat(15) }),
    ).toThrow('OVO_SIP_CONTROL_TOKEN must be at least 16 characters');
  });

  it.each([
    'ftp://172.29.240.1:5090',
    'http://user:pass@172.29.240.1:5090',
    'http://172.29.240.1:5090/v1',
    'http://172.29.240.1:5090/?x=1',
    'not a url',
  ])('refuses the control URL %s', (url) => {
    expect(() =>
      sipTrunkControlPlugins({
        OVO_SIP_ENABLED: 'true',
        OVO_SIP_CONTROL_TOKEN: TOKEN,
        OVO_SIP_CONTROL_URL: url,
      }),
    ).toThrow('OVO_SIP_CONTROL_URL must be an http(s) origin');
  });

  it('defaults to the compose bridge address the sip-gateway listens on', () => {
    expect(DEFAULT_SIP_CONTROL_URL).toBe('http://172.29.240.1:5090');
    expect(
      sipTrunkControlPlugins({ OVO_SIP_ENABLED: 'true', OVO_SIP_CONTROL_TOKEN: TOKEN }),
    ).toHaveLength(1);
  });
});

describe('worker composition of the installed SIP carriers (Wave 11)', () => {
  const dial: DialRequest = {
    requestId: 'req-1',
    jobId: 'job-1',
    to: '+919876543210',
    from: '+918000000001',
    media: {
      url: 'wss://ovo.example.test/carriers/tcn/b1/media',
      routeParams: { sid: 's', rt: 'r' },
      format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
    },
    callbacks: {
      status: 'https://ovo.example.test/carriers/tcn/b1/status?r=req-1&t=x',
      answer: 'https://ovo.example.test/carriers/tcn/b1/answer?r=req-1&t=x',
    },
    maxDurationSec: 60,
  };

  async function carriers(env: Record<string, string>) {
    const distribution = await loadDistribution({
      role: 'worker',
      profile: 'compose',
      // The worker profile reads these to list its durable rows; nothing connects.
      env: {
        DATABASE_URL: 'postgres://local',
        OVO_QUEUE_URL: 'http://localhost/queue',
        AWS_REGION: 'us-east-1',
        OVO_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      },
      log: () => undefined,
    });
    const ids = ['@winsendotai/ovo-carrier-sip', '@winsendotai/ovo-carrier-tcn'];
    const hosts = sipTrunkControlPlugins(env);
    const graph = await compose(
      [...hosts.map((plugin) => ({ id: plugin.manifest.id })), ...ids.map((id) => ({ id }))],
      [...distribution.catalog, ...hosts],
      { scope: 'process' },
    );
    closers.push(() => graph.dispose());
    return (provider: string) =>
      graph.all(Cap.carrierControl).get(provider) as CarrierControlFactory;
  }

  const binding = (pluginId: string, config: Record<string, unknown>) => ({
    bindingId: 'b1',
    pluginId,
    workspaceId: 'w1',
    config,
    secret: '',
  });

  it('dials sip and an opted-in tcn binding through the sip-gateway control API', async () => {
    const api = await controlApi();
    const control = await carriers({
      OVO_SIP_ENABLED: 'true',
      OVO_SIP_CONTROL_TOKEN: TOKEN,
      OVO_SIP_CONTROL_URL: api.url,
    });
    const tcn = binding('@winsendotai/ovo-carrier-tcn', {
      trunkId: 'tcn-sg',
      outboundEnabled: true,
    });
    expect(await control('tcn').create(tcn).dial(dial)).toMatchObject({ kind: 'accepted' });
    const sip = binding('@winsendotai/ovo-carrier-sip', { trunkId: 'in-trunk' });
    expect(await control('sip').create(sip).dial(dial)).toMatchObject({ kind: 'accepted' });
    expect(api.seen.map((request) => [request.url, request.authorization])).toEqual([
      ['/v1/calls', `Bearer ${TOKEN}`],
      ['/v1/calls', `Bearer ${TOKEN}`],
    ]);
    expect(api.seen.map((request) => JSON.parse(request.body).carrierId)).toEqual(['tcn', 'sip']);
  });

  it('refuses every sip/tcn dial while SIP is off, without any request', async () => {
    const control = await carriers({ OVO_SIP_ENABLED: 'false' });
    const tcn = binding('@winsendotai/ovo-carrier-tcn', {
      trunkId: 'tcn-sg',
      outboundEnabled: true,
    });
    expect(await control('tcn').create(tcn).dial(dial)).toMatchObject({
      kind: 'rejected',
      reason: 'sip_trunk_unavailable',
      retryable: false,
    });
  });
});
