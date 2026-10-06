import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeNet, type NodeNet } from '../src/index.ts';

// LAT-8: undici's default idle keep-alive (4s) is shorter than the gap between caller turns, so
// the decision, LLM and TLS-terminated TTS requests paid TCP+TLS again on most turns.
const fixtures = new URL('../../conformance/fixtures/tls/', import.meta.url);
const cert = readFileSync(new URL('localhost-cert.pem', fixtures));
const key = readFileSync(new URL('localhost-key.pem', fixtures));

async function tlsServer(): Promise<{
  origin: string;
  handshakes: number;
  requests: string[];
  close(): Promise<void>;
}> {
  const state = { handshakes: 0, requests: [] as string[] };
  const server: Server = createServer({ cert, key }, (request, response) => {
    state.requests.push(`${request.method} ${request.url}`);
    response.writeHead(request.url === '/' ? 404 : 200).end('ok');
  });
  server.on('secureConnection', () => (state.handshakes += 1));
  // No `Keep-Alive: timeout=` hint (OpenAI sends none), so the client's own idle lifetime applies;
  // a hint would win over it by design.
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get handshakes() {
      return state.handshakes;
    },
    requests: state.requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const opened: { close(): Promise<void> }[] = [];
const track = <T extends { close(): Promise<void> }>(value: T) => (opened.push(value), value);
afterEach(async () => {
  await Promise.all(opened.splice(0).map((entry) => entry.close()));
});

const loopbackNet = (options: Parameters<typeof createNodeNet>[0] = {}): NodeNet =>
  track(createNodeNet({ tls: { ca: cert }, allowedPrivateAddresses: ['127.0.0.1'], ...options }));

const get = async (net: NodeNet, url: string) => {
  const response = await net.fetch(url);
  await response.text();
  return response.status;
};

describe('pooled provider connections (LAT-8)', () => {
  it('reuses one TLS connection across a turn gap longer than undici’s 4s default', async () => {
    const server = track(await tlsServer());
    const net = loopbackNet();
    expect(await get(net, `${server.origin}/turn`)).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    expect(await get(net, `${server.origin}/turn`)).toBe(200);
    expect(server.handshakes).toBe(1);
  }, 15_000);

  it('honours a configured idle lifetime, so the reuse above is the keep-alive at work', async () => {
    const server = track(await tlsServer());
    const net = loopbackNet({ keepAlive: { keepAliveTimeoutMs: 100 } });
    await get(net, `${server.origin}/turn`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await get(net, `${server.origin}/turn`);
    expect(server.handshakes).toBe(2);
  });

  it('pre-warms an origin so the first provider request skips the handshake', async () => {
    const server = track(await tlsServer());
    const net = loopbackNet();
    const [result] = await net.prewarm([server.origin, server.origin]);
    expect(result).toMatchObject({ origin: server.origin, ok: true, status: 404 });
    expect(server.requests).toEqual(['GET /']);
    expect(server.handshakes).toBe(1);
    // The first turn comes later than the warm-up; a request issued in the same tick as the
    // warm-up's completion would find the socket still busy and open a second one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await get(net, `${server.origin}/v1/responses`);
    expect(server.handshakes).toBe(1);
  });

  it('reports a failed warm-up instead of throwing', async () => {
    const server = await tlsServer();
    const origin = server.origin;
    await server.close();
    const net = loopbackNet();
    const [result] = await net.prewarm([origin, 'http://plain.example'], { timeoutMs: 1_000 });
    expect(result).toMatchObject({ origin, ok: false });
    expect((await net.prewarm(['http://plain.example']))[0]).toMatchObject({ ok: false });
  });
});
