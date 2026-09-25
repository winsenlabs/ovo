import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  fixtureCarrierIngress,
  fixtureSignature,
} from '../../conformance/src/drivers/fixture-carrier.ts';
import type {
  CarrierHostPorts,
  CarrierHttpRequest,
  CarrierIngress,
  UpgradeRequest,
} from '@winsendotai/ovo-contracts';
import { CarrierRouter, type CarrierRouterOptions } from '../src/router.ts';
import { publicRequestUrl } from '../src/upgrade.ts';

const source = fixtureCarrierIngress();
const opened: Array<{ server: Server; router: CarrierRouter }> = [];
afterEach(async () => {
  for (const { server, router } of opened.splice(0)) {
    router.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function host(overrides: Partial<CarrierHostPorts> = {}): CarrierHostPorts {
  return {
    async resolveBinding(bindingId) {
      return {
        bindingId,
        pluginId: 'fixture',
        workspaceId: 'workspace',
        config: {},
        secret: 'fixture-secret',
      };
    },
    verifyUrlSecret: () => true,
    ...overrides,
  } as CarrierHostPorts;
}

it('uses only the public origin, elides the default port, and retains the exact encoded path', () => {
  expect(
    publicRequestUrl(
      'https://voice.example:443/configured/path',
      '/carriers/fixture/b%20id/media?sid=A&t=T',
      'wss',
    ),
  ).toMatchObject({
    externalUrl: 'wss://voice.example/carriers/fixture/b%20id/media',
    pathname: '/carriers/fixture/b%20id/media',
    url: { search: '?sid=A&t=T' },
  });
  expect(() =>
    publicRequestUrl('https://voice.example', '/carriers/fixture/../media', 'wss'),
  ).toThrow('canonical');
});

async function serve(options: CarrierRouterOptions) {
  const router = new CarrierRouter(options);
  const server = createServer((request, response) => {
    void router.handleHttp(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  server.on('upgrade', (request, socket, head) => {
    void router.handleUpgrade(request, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  opened.push({ server, router });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return `http://127.0.0.1:${address.port}`;
}

it('routes canonical GET/POST and aliases by carrier, binding and purpose with exact public URLs', async () => {
  const seen: CarrierHttpRequest[] = [];
  const selected: string[] = [];
  const ingress: CarrierIngress = {
    ...source,
    routes: [
      ...(['POST', 'GET'] as const).map((method) => ({
        method,
        purpose: 'status' as const,
        async handle(request: CarrierHttpRequest) {
          seen.push(request);
          return { status: 200, contentType: 'text/plain', body: `${method}:${request.bindingId}` };
        },
      })),
    ],
    legacyPaths: { '/legacy/status': { purpose: 'status', bindingId: 'alias-binding' } },
  };
  const origin = await serve({
    ingresses: [ingress],
    publicBaseUrl: 'https://voice.example:8443/configured-base',
    hostFor(carrierId, bindingId) {
      selected.push(`${carrierId}/${bindingId}`);
      return host();
    },
    onConnected: () => undefined,
  });
  const body = 'CallSid=CA123';
  const post = await fetch(`${origin}/carriers/fixture/b%20id/status?sid=A&t=T`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test': 'wire' },
    body,
  });
  expect(post.status).toBe(200);
  expect(await post.text()).toBe('POST:b id');
  expect(seen[0]).toMatchObject({
    method: 'POST',
    externalUrl: 'https://voice.example:8443/carriers/fixture/b%20id/status',
    query: { sid: 'A', t: 'T' },
    headers: { 'x-test': 'wire' },
    bindingId: 'b id',
    remoteAddress: '127.0.0.1',
  });
  expect(new TextDecoder().decode(seen[0]!.rawBody)).toBe(body);
  const alias = await fetch(`${origin}/legacy/status?x=1`);
  expect(await alias.text()).toBe('GET:alias-binding');
  expect(seen[1]).toMatchObject({
    externalUrl: 'https://voice.example:8443/legacy/status',
    query: { x: '1' },
  });
  expect(selected).toEqual(['fixture/b id', 'fixture/alias-binding']);
  expect((await fetch(`${origin}/carriers/unknown/b/status`)).status).toBe(404);
  expect((await fetch(`${origin}/carriers/fixture/b/unknown`)).status).toBe(404);
  expect((await fetch(`${origin}/carriers/fixture/b/status`, { method: 'PUT' })).status).toBe(404);
});

it('authenticates a fixture legacy media alias before ws upgrade and refuses bad or unknown routes', async () => {
  const accepted: Array<Parameters<CarrierRouterOptions['onConnected']>[0]> = [];
  const ingress = {
    ...source,
    legacyPaths: { '/legacy/media': { purpose: 'media' as const, bindingId: 'old-binding' } },
  };
  const origin = await serve({
    ingresses: [ingress],
    publicBaseUrl: 'https://voice.example:8443',
    hostFor: () => host(),
    onConnected(value) {
      accepted.push(value);
    },
  });
  const endpoint = `${origin.replace('http:', 'ws:')}/legacy/media`;
  const signature = fixtureSignature('fixture-secret', 'wss://voice.example:8443/legacy/media');
  const good = new WebSocket(endpoint, { headers: { 'x-fixture-signature': signature } });
  await once(good, 'open');
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({ ingress, bindingId: 'old-binding', params: {} });
  expect(accepted[0]!.codec.decode('{"event":"connected"}')).toEqual([{ type: 'connected' }]);
  good.close();
  await once(good, 'close');
  const denied = new WebSocket(endpoint, { headers: { 'x-fixture-signature': 'bad' } });
  await expect(once(denied, 'open')).rejects.toThrow('Unexpected server response: 401');
  expect(accepted).toHaveLength(1);
  const unknown = new WebSocket(`${origin.replace('http:', 'ws:')}/carriers/nope/b/media`);
  await expect(once(unknown, 'open')).rejects.toThrow('Unexpected server response: 404');
});

it('passes full wss URL including query, query-free external URL, and scoped URL-secret context', async () => {
  const requests: UpgradeRequest[] = [];
  const verifications: CarrierHttpRequest[] = [];
  const selected: string[] = [];
  const ingress: CarrierIngress = {
    ...source,
    serializer: {
      async authenticateUpgrade(request, ctx) {
        requests.push(request);
        const ok = ctx.verifyUrlSecret({
          purpose: 'media',
          bindingId: ctx.bindingId,
          requestId: 'A',
          token: request.url.searchParams.get('t'),
        });
        return ok
          ? { ok: true, params: { sid: request.url.searchParams.get('sid') ?? '' } }
          : { ok: false, status: 403 };
      },
      createSession: source.serializer.createSession,
    },
  };
  const accepted: Array<Parameters<CarrierRouterOptions['onConnected']>[0]> = [];
  const origin = await serve({
    ingresses: [ingress],
    publicBaseUrl: 'https://voice.example:8443',
    hostFor(carrierId, bindingId) {
      selected.push(`${carrierId}/${bindingId}`);
      return host({
        verifyUrlSecret(request, check) {
          verifications.push(request);
          return (
            check.purpose === 'media' && check.requestId === 'A' && request.query.t === 'token'
          );
        },
      });
    },
    onConnected(value) {
      accepted.push(value);
    },
  });
  const client = new WebSocket(
    `${origin.replace('http:', 'ws:')}/carriers/fixture/binding/media?sid=A&rt=B&t=token`,
  );
  await once(client, 'open');
  expect(selected).toEqual(['fixture/binding']);
  expect(requests[0]?.url.href).toBe(
    'wss://voice.example:8443/carriers/fixture/binding/media?sid=A&rt=B&t=token',
  );
  expect(requests[0]?.externalUrl).toBe('wss://voice.example:8443/carriers/fixture/binding/media');
  expect(verifications[0]).toMatchObject({
    externalUrl: 'https://voice.example:8443/carriers/fixture/binding/media',
    query: { sid: 'A', rt: 'B', t: 'token' },
    bindingId: 'binding',
  });
  expect(accepted[0]).toMatchObject({ bindingId: 'binding', params: { sid: 'A' } });
  client.close();
  await once(client, 'close');
});

it('does not substitute a query token when the serializer reports a missing token', async () => {
  let hostChecks = 0;
  let accepted = 0;
  const ingress: CarrierIngress = {
    ...source,
    serializer: {
      async authenticateUpgrade(_request, ctx) {
        const ok = ctx.verifyUrlSecret({
          purpose: 'media',
          bindingId: ctx.bindingId,
          token: null,
        });
        return ok ? { ok: true, params: {} } : { ok: false, status: 403 };
      },
      createSession: source.serializer.createSession,
    },
  };
  const origin = await serve({
    ingresses: [ingress],
    publicBaseUrl: 'https://voice.example',
    hostFor: () =>
      host({
        verifyUrlSecret: () => {
          hostChecks += 1;
          return true;
        },
      }),
    onConnected() {
      accepted += 1;
    },
  });
  const client = new WebSocket(
    `${origin.replace('http:', 'ws:')}/carriers/fixture/b/media?t=forged`,
  );
  await expect(once(client, 'open')).rejects.toThrow('Unexpected server response: 403');
  expect(hostChecks).toBe(0);
  expect(accepted).toBe(0);
});
