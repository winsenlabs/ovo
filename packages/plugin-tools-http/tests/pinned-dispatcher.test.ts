import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Agent, buildConnector } from 'undici';

/**
 * `createPinnedFetch` pins the connection by handing an undici `Agent` to a fetch implementation.
 * Node 22/24's GLOBAL fetch bundles an older undici that refuses an undici@8 dispatcher ("fetch
 * failed"), so pairing the two disabled the pinned path in production, and no test caught it
 * because every other test injects `dependencies.fetch`. Node 26's bundled undici accepts one.
 * The implementation therefore imports undici's own fetch, which honours the dispatcher on every
 * supported Node; that is what this pins. (net-guard.test.ts proves the pinned address is used.)
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

/** An agent whose connector counts the sockets it opened: proof the dispatcher was used. */
function countingAgent() {
  const base = buildConnector({});
  const state = { connections: 0 };
  const agent = new Agent({
    connect: (options, callback) => {
      state.connections += 1;
      base(options, callback);
    },
  });
  return { agent, state };
}

it('undici fetch sends the request through the given dispatcher', async () => {
  const { agent, state } = countingAgent();
  const { fetch: undiciFetch } = await import('undici');
  const pinned = await undiciFetch(url, { dispatcher: agent });
  expect(await pinned.text()).toBe('ok');
  expect(state.connections).toBe(1);
  await agent.close();
});

it('the global fetch never silently bypasses an undici dispatcher: it refuses it or uses it', async () => {
  // Node <= 24 refuses (the reason for importing undici's fetch); Node 26 uses it. Either is
  // safe. A global fetch that answered without opening the agent's socket would be the bug.
  const { agent, state } = countingAgent();
  const outcome = await globalThis
    .fetch(url, { dispatcher: agent } as RequestInit)
    .then(async (response) => ({ ok: true as const, body: await response.text() }))
    .catch((error: unknown) => ({ ok: false as const, error }));
  if (outcome.ok) {
    expect(outcome.body).toBe('ok');
    expect(state.connections).toBe(1);
  } else expect(String(outcome.error)).toMatch(/fetch failed/);
  await agent.close();
});
