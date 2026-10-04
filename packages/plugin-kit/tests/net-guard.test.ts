import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorPolicyError, createNodeNet, type NodeNet } from '../src/index.ts';
import { createGuardedConnector } from '../src/net-pinning.ts';

/** A TCP listener on 127.0.0.1 that counts connections and never speaks. Loopback only. */
async function countingListener(options: { hold?: boolean } = {}): Promise<{
  port: number;
  connections: number;
  connected: Promise<void>;
  close(): Promise<void>;
}> {
  const state = { connections: 0 };
  const open: Socket[] = [];
  let announce = () => undefined as void;
  const connected = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const server: Server = createServer((socket) => {
    state.connections += 1;
    announce();
    socket.on('error', () => undefined);
    // Never speak TLS: the point is that the connection arrived here, not what it carries.
    if (options.hold) open.push(socket);
    else socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get connections() {
      return state.connections;
    },
    connected,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const lookupOf = (answers: Record<string, string[]>) => async (host: string) =>
  (answers[host] ?? []).map(
    (address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const,
  );

const socketError = (net: NodeNet, url: string) =>
  new Promise<unknown>((resolve) => {
    const socket = net.websocket(url);
    socket.on('error', (error) => resolve(error));
    socket.on('open', () => resolve(new Error('unexpectedly opened')));
  });

const ports: NodeNet[] = [];
const track = (net: NodeNet) => (ports.push(net), net);

afterEach(async () => {
  await Promise.all(ports.splice(0).map((net) => net.close()));
});

describe('createNodeNet refuses private destinations (#24)', () => {
  const BLOCKED = [
    ['cloud metadata', 'https://169.254.169.254/'],
    ['loopback service', 'https://127.0.0.1:8500/'],
    ['RFC 1918', 'https://10.0.0.5/admin'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['IPv4-mapped metadata', 'https://[::ffff:169.254.169.254]/'],
    ['localhost by name', 'https://localhost/'],
  ] as const;

  it.each(BLOCKED)('fetch refuses %s', async (_label, url) => {
    const net = track(createNodeNet());
    await expect(net.fetch(url)).rejects.toBeInstanceOf(ConnectorPolicyError);
  });

  it.each(BLOCKED)('websocket refuses %s', async (_label, url) => {
    const net = track(createNodeNet());
    expect(await socketError(net, url.replace('https:', 'wss:'))).toBeInstanceOf(
      ConnectorPolicyError,
    );
  });

  it('refuses a name whose DNS answer is a metadata address, before any socket', async () => {
    const listener = await countingListener();
    try {
      const net = track(
        createNodeNet({
          lookup: lookupOf({ 'metadata.google.internal': ['169.254.169.254'] }),
        }),
      );
      await expect(net.fetch('https://metadata.google.internal/')).rejects.toBeInstanceOf(
        ConnectorPolicyError,
      );
      expect(await socketError(net, 'wss://metadata.google.internal/')).toBeInstanceOf(
        ConnectorPolicyError,
      );
      expect(listener.connections).toBe(0);
    } finally {
      await listener.close();
    }
  });

  it('refuses an allow-listed vendor host that also resolves to a private address', async () => {
    const net = track(
      createNodeNet({ lookup: lookupOf({ 'api.vendor.test': ['93.184.216.34', '10.0.0.5'] }) }),
    );
    const error = await net.fetch('https://api.vendor.test/v1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorPolicyError);
    expect((error as Error).message).toMatch(/private or special-use/i);
  });
});

describe('createNodeNet pins the connection to the validated addresses', () => {
  it('dials only the pinned address, for a name DNS cannot answer', async () => {
    const listener = await countingListener();
    try {
      // `pinned.test` is in the reserved .test TLD: it never resolves. Reaching the listener at
      // all proves the socket was dialled at the address the lookup returned and nothing else.
      const net = track(
        createNodeNet({
          lookup: lookupOf({ 'pinned.test': ['127.0.0.1'] }),
          allowedPrivateAddresses: ['127.0.0.1'],
        }),
      );
      const request = net.fetch(`https://pinned.test:${listener.port}/x`).catch(() => undefined);
      await listener.connected;
      expect(listener.connections).toBe(1);
      await request;
    } finally {
      await listener.close();
    }
  });

  it('opens a websocket at the pinned address too', async () => {
    const listener = await countingListener();
    try {
      const net = track(
        createNodeNet({
          lookup: lookupOf({ 'pinned.test': ['127.0.0.1'] }),
          allowedPrivateAddresses: ['127.0.0.1'],
        }),
      );
      const socket = net.websocket(`wss://pinned.test:${listener.port}/ws`);
      socket.on('error', () => undefined);
      await listener.connected;
      expect(listener.connections).toBe(1);
      socket.close();
    } finally {
      await listener.close();
    }
  });

  it('still refuses a private address that was not allow-listed', async () => {
    const listener = await countingListener();
    try {
      const net = track(
        createNodeNet({
          lookup: lookupOf({ 'pinned.test': ['127.0.0.1'] }),
          allowedPrivateAddresses: ['203.0.114.1'],
        }),
      );
      await expect(net.fetch(`https://pinned.test:${listener.port}/x`)).rejects.toBeInstanceOf(
        ConnectorPolicyError,
      );
      expect(listener.connections).toBe(0);
    } finally {
      await listener.close();
    }
  });
});

/**
 * The last line of defence, for a composition that has no `lookup` to pre-resolve with: whatever
 * DNS answered, the peer of the connected socket is judged before a single byte is written.
 */
describe('the guarded connector judges the peer it actually reached', () => {
  const connect = (policy: { allowedPrivateAddresses: readonly string[] }, port: number) =>
    new Promise<{ error: Error | null; peer?: string }>((resolve) => {
      createGuardedConnector({ addresses: [], ...policy })(
        { hostname: '127.0.0.1', protocol: 'http:', port: String(port) },
        (error, socket) => resolve({ error, peer: socket?.remoteAddress }),
      );
    });

  it('destroys a connection that landed on a private address, after it was accepted', async () => {
    const listener = await countingListener({ hold: true });
    try {
      const { error, peer } = await connect({ allowedPrivateAddresses: [] }, listener.port);
      expect(error).toBeInstanceOf(ConnectorPolicyError);
      expect((error as Error).message).toMatch(/non-public address 127\.0\.0\.1/);
      expect(peer).toBeUndefined();
      // The TCP connection was made — and then refused before the transport could write to it.
      // Wait for the SERVER's connection event: the client-side callback resolves in a different
      // task, so asserting the counter straight away races it (it failed ~8% of the time).
      await listener.connected;
      expect(listener.connections).toBe(1);
    } finally {
      await listener.close();
    }
  });

  it('hands over a connection whose peer the caller allow-listed', async () => {
    const listener = await countingListener({ hold: true });
    try {
      const { error, peer } = await connect(
        { allowedPrivateAddresses: ['127.0.0.1'] },
        listener.port,
      );
      expect(error).toBeNull();
      expect(peer).toBe('127.0.0.1');
    } finally {
      await listener.close();
    }
  });
});
