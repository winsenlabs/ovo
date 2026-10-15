import { ExternalEngine, RoutingEngineError } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  callExternalRouteEngine,
  routeDecisionSignature,
  type ExternalRouteOptions,
} from '../src/routing-external.ts';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
const engine = (overrides: Record<string, unknown> = {}) =>
  ExternalEngine.parse({
    kind: 'external',
    endpoint: 'https://decide.example.test/route',
    credentialId: 'cred-route',
    timeoutMs: 200,
    slots: ['product'],
    ...overrides,
  });
const input = (overrides: Record<string, unknown> = {}) => ({
  node: 'intent',
  engine: engine(overrides),
  turn: { text: 'I want a new card', digits: '1' },
  context: { language: 'hi', values: { segment: 'retail' } },
  branches: ['sales', 'support'],
});

function options(
  fetch: typeof globalThis.fetch,
  overrides: Partial<ExternalRouteOptions> = {},
): ExternalRouteOptions {
  return {
    enabled: true,
    workspaceId: 'workspace-1',
    secrets: { resolve: vi.fn(async () => 'route-secret') },
    call: {
      callId: 'call-1',
      workspaceId: 'workspace-1',
      routingPointId: 'point-1',
      routingReleaseId: 'routing-release-1',
      from: '+919800000001',
      to: '+918000000002',
      variables: { tier: 'gold', nested: { a: 1 } },
    },
    network: { lookup: publicLookup, fetch },
    now: () => 1_760_000_000_000,
    requestId: () => 'req-1',
    ...overrides,
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
const signal = () => new AbortController().signal;

async function failure(promise: Promise<unknown>): Promise<{ kind: string; message: string }> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RoutingEngineError);
  const { kind, message } = error as RoutingEngineError;
  return { kind, message };
}

describe('the external decision webhook (routing design 7.6)', () => {
  it('signs v1 HMAC-SHA256 over timestamp, request id and the raw body (fixed vector)', () => {
    // Computed independently: python3 hmac.new(b'route-secret', b'1760000000.req-1.' + body, sha256)
    expect(
      routeDecisionSignature(
        'route-secret',
        '1760000000',
        'req-1',
        '{"schema":"ovo.route-decision/1"}',
      ),
    ).toBe('v1=89b525d3dd7a82affe60cf6c0ffa4c57e2702fa87b53b36a36f07a9a45901be3');
  });

  it('posts ovo.route-decision/1 with signed headers and returns the parsed answer', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({ branch: 'sales', confidence: 0.8, slots: { product: 'cards' }, extra: true }),
    );
    const decision = await callExternalRouteEngine(
      options(fetch as never),
      input({ send: { turnText: true, callerId: false, variables: ['tier', 'nested'] } }),
      signal(),
    );
    expect(decision).toMatchObject({
      branch: 'sales',
      confidence: 0.8,
      slots: { product: 'cards' },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://decide.example.test/route');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    const body = String(init?.body);
    expect(JSON.parse(body)).toEqual({
      schema: 'ovo.route-decision/1',
      requestId: 'req-1',
      routingPointId: 'point-1',
      routingReleaseId: 'routing-release-1',
      node: 'intent',
      callId: 'call-1',
      sentAt: '2025-10-09T08:53:20.000Z',
      branches: ['sales', 'support'],
      context: { language: 'hi', values: { segment: 'retail' } },
      turn: { text: 'I want a new card', digits: '1' },
      variables: { tier: 'gold' },
    });
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'x-ovo-request-id': 'req-1',
      'x-ovo-timestamp': '1760000000',
      'x-ovo-signature': routeDecisionSignature('route-secret', '1760000000', 'req-1', body),
    });
  });

  it('sends caller numbers and turn text only when the engine says so', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({ branch: null }),
    );
    await callExternalRouteEngine(
      options(fetch as never),
      input({ send: { turnText: false, callerId: true, variables: [] } }),
      signal(),
    );
    const sent = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(sent.turn).toEqual({ digits: '1' });
    expect(sent.caller).toEqual({ from: '+919800000001', to: '+918000000002' });
    expect(sent).not.toHaveProperty('variables');
  });

  it('reports disabled without reading the secret or calling out while the flag is off', async () => {
    const fetch = vi.fn();
    const off = options(fetch as never, { enabled: false });
    expect(await failure(callExternalRouteEngine(off, input(), signal()))).toEqual({
      kind: 'disabled',
      message: 'disabled',
    });
    expect(off.secrets.resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('times out after the engine timeout, one attempt', async () => {
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    expect(
      await failure(
        callExternalRouteEngine(options(fetch as never), input({ timeoutMs: 100 }), signal()),
      ),
    ).toEqual({ kind: 'timeout', message: 'timeout' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('refuses a redirect', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }),
    );
    expect(
      await failure(callExternalRouteEngine(options(fetch as never), input(), signal())),
    ).toEqual({ kind: 'transport', message: 'redirect' });
  });

  it('refuses a host that resolves to a private address', async () => {
    const fetch = vi.fn();
    const privateLookup = async () => [{ address: '10.0.0.7', family: 4 as const }];
    const result = callExternalRouteEngine(
      options(fetch as never, { network: { lookup: privateLookup, fetch: fetch as never } }),
      input(),
      signal(),
    );
    expect(await failure(result)).toEqual({ kind: 'transport', message: 'policy' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an answer over 16 KiB', async () => {
    const fetch = vi.fn(async () => json({ branch: 'sales', padding: 'x'.repeat(17 * 1024) }));
    expect(
      await failure(callExternalRouteEngine(options(fetch as never), input(), signal())),
    ).toEqual({ kind: 'transport', message: 'oversize' });
  });

  it('refuses invalid JSON, an unknown branch, an unlisted slot and a non-2xx answer', async () => {
    const answers: [Response, string][] = [
      [new Response('{not json'), 'invalid'],
      [json({ branch: 'Sales!' }), 'invalid'],
      [json({ branch: 'billing' }), 'unknown_branch'],
      [json({ branch: 'sales', slots: { account: 'x' } }), 'slot_not_allowed'],
      [json({ branch: 'sales' }, { status: 503 }), 'http_503'],
    ];
    for (const [response, reason] of answers) {
      const result = callExternalRouteEngine(
        options((async () => response) as never),
        input(),
        signal(),
      );
      expect((await failure(result)).message).toBe(reason);
    }
  });
});
