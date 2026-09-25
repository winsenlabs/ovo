import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Agent } from 'undici';

/**
 * `createPinnedFetch` pins the connection by handing an undici `Agent` to a fetch implementation.
 * Node 22's GLOBAL fetch refuses an undici@8 dispatcher ("invalid onRequestStart method"), so
 * pairing the two disables the pinned path in production — and no test caught it, because every
 * other test injects `dependencies.fetch` and never exercises the real one. This pins the reason
 * the implementation imports undici's own fetch.
 */
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

it('needs undici fetch for an undici dispatcher; the global fetch rejects one', async () => {
  const agent = new Agent({ connect: {} });
  const { fetch: undiciFetch } = await import('undici');

  const pinned = await undiciFetch(url, { dispatcher: agent });
  expect(await pinned.text()).toBe('ok');

  await expect(globalThis.fetch(url, { dispatcher: agent } as RequestInit)).rejects.toThrow(
    /fetch failed/,
  );
  await agent.close();
});
