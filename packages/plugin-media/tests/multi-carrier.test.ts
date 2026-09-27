import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { Cap, type CarrierHostPorts, type CarrierIngress } from '@winsendotai/ovo-contracts';
import {
  fixtureCarrierIngress,
  fixtureSignature,
} from '../../conformance/src/drivers/fixture-carrier.ts';
import { MediaGateway } from '../src/gateway.ts';
import { createMediaGatewayPlugin } from '../src/plugin.ts';
import { CarrierRouter } from '../src/router.ts';

const publicBaseUrl = 'https://voice.example:8443';
const secretFor = (carrierId: string, bindingId: string) => `${carrierId}:${bindingId}:secret`;

function ingress(carrierId: string): CarrierIngress {
  const source = fixtureCarrierIngress();
  return {
    ...source,
    carrierId,
    capabilities: { ...source.capabilities, carrierId },
    legacyPaths: {
      [`/legacy/${carrierId}/status`]: { purpose: 'status', bindingId: 'legacy' },
      [`/legacy/${carrierId}/media`]: { purpose: 'media', bindingId: 'legacy' },
    },
    routes: (['GET', 'POST'] as const).map((method) => ({
      method,
      purpose: 'status',
      async handle(request, host) {
        const binding = await host.resolveBinding(request.bindingId);
        const authenticated =
          request.headers['x-fixture-signature'] ===
          fixtureSignature(binding.secret, request.externalUrl);
        return {
          status: authenticated ? 200 : 401,
          contentType: 'text/plain',
          body: authenticated ? `${carrierId}:${binding.bindingId}` : 'unauthorized',
        };
      },
    })),
  };
}

function hostFor(carrierId: string, bindingId: string): CarrierHostPorts {
  return {
    async resolveBinding(requestedId) {
      expect(requestedId).toBe(bindingId);
      return {
        bindingId,
        pluginId: `test-${carrierId}`,
        workspaceId: 'workspace',
        config: {},
        secret: secretFor(carrierId, bindingId),
      };
    },
  } as CarrierHostPorts;
}

function resolver() {
  return {
    authenticateSessionRoute: vi.fn(),
    resolveSessionRoute: vi.fn(),
    bindCarrierCallId: vi.fn(),
    recordCarrierCallIdMismatch: vi.fn(),
  };
}

it('routes three installed carriers over canonical and alias HTTP/WS paths with scoped secrets', async () => {
  const selected: string[] = [];
  const carriers = ['alpha', 'beta', 'gamma'];
  const gateway = new MediaGateway(resolver(), {
    publicBaseUrl,
    workerToken: 'worker-secret',
    ingresses: carriers.map(ingress),
    hostFor(carrierId, bindingId) {
      selected.push(`${carrierId}/${bindingId}`);
      return hostFor(carrierId, bindingId);
    },
  });
  const { port } = await gateway.listen();
  const origin = `http://127.0.0.1:${port}`;
  const expectedScopes: string[] = [];
  const sockets: WebSocket[] = [];
  const signature = (carrierId: string, bindingId: string, path: string, scheme = 'https') => ({
    'x-fixture-signature': fixtureSignature(
      secretFor(carrierId, bindingId),
      `${publicBaseUrl.replace('https:', `${scheme}:`)}${path}`,
    ),
  });
  try {
    for (const carrierId of carriers) {
      for (const [path, bindingId] of [
        [`/carriers/${carrierId}/shared`, 'shared'],
        [`/legacy/${carrierId}`, 'legacy'],
      ]) {
        for (const method of ['GET', 'POST']) {
          const callback = `${path}/status?raw=%2f+%20`;
          const response = await fetch(origin + callback, {
            method,
            headers: signature(carrierId!, bindingId!, callback),
          });
          expect(response.status).toBe(200);
          expect(await response.text()).toBe(`${carrierId}:${bindingId}`);
          expectedScopes.push(`${carrierId}/${bindingId}`);
        }
        const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${path}/media`, {
          headers: signature(carrierId!, bindingId!, `${path}/media`, 'wss'),
        });
        sockets.push(socket);
        await once(socket, 'open');
        expectedScopes.push(`${carrierId}/${bindingId}`);
        socket.close();
        await once(socket, 'close');
      }
    }
    // Use beta's secret to sign alpha's exact URL: this isolates host scoping,
    // rather than failing just because the signature contains a different path.
    const callback = '/carriers/alpha/shared/status';
    const denied = await fetch(origin + callback, {
      method: 'POST',
      headers: signature('beta', 'shared', callback),
    });
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe('unauthorized');
    expectedScopes.push('alpha/shared');
    const wrongSocket = new WebSocket(
      `${origin.replace('http:', 'ws:')}/carriers/alpha/shared/media`,
      {
        headers: signature('beta', 'shared', '/carriers/alpha/shared/media', 'wss'),
      },
    );
    sockets.push(wrongSocket);
    await expect(once(wrongSocket, 'open')).rejects.toThrow('Unexpected server response: 401');
    expectedScopes.push('alpha/shared');
    expect((await fetch(`${origin}/carriers/unknown/shared/status`)).status).toBe(404);
    const unknownSocket = new WebSocket(
      `${origin.replace('http:', 'ws:')}/carriers/unknown/shared/media`,
    );
    sockets.push(unknownSocket);
    await expect(once(unknownSocket, 'open')).rejects.toThrow('Unexpected server response: 404');
    expect(selected).toEqual(expectedScopes);
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.terminate();
    await gateway.close();
  }
});

it.each(['carrierId', 'alias'] as const)(
  'refuses duplicate %s across installed ingresses',
  (duplicate) => {
    const first = ingress('alpha');
    const second = {
      ...ingress(duplicate === 'carrierId' ? 'alpha' : 'beta'),
      legacyPaths: duplicate === 'alias' ? first.legacyPaths : ingress('beta').legacyPaths,
    };
    let router: CarrierRouter | undefined;
    try {
      expect(() => {
        router = new CarrierRouter({
          ingresses: [first, second],
          publicBaseUrl,
          hostFor,
          onConnected() {},
        });
      }).toThrow(
        duplicate === 'carrierId'
          ? 'Duplicate carrier ingress alpha'
          : 'Duplicate carrier alias /legacy/alpha/status',
      );
    } finally {
      router?.close();
    }
  },
);

it('refuses gateway plugin startup when no carrier ingress is installed', async () => {
  const plugin = createMediaGatewayPlugin({ workerToken: 'worker-secret' }, { hostFor });
  const provided: MediaGateway[] = [];
  const all = vi.fn(() => new Map());
  const ctx = {
    get: () => resolver(),
    all,
    provide: (_key: string, value: MediaGateway) => provided.push(value),
    effect() {},
  } as unknown as Parameters<typeof plugin.apply>[0];
  try {
    await expect(plugin.apply(ctx, { publicBaseUrl })).rejects.toThrow(
      'No carrier ingress is installed',
    );
    expect(all).toHaveBeenCalledWith(Cap.carrierIngress);
    expect(provided).toEqual([]);
  } finally {
    for (const gateway of provided) await gateway.close();
  }
});
