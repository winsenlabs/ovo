import { afterEach, expect, it, vi } from 'vitest';
import type { ToolConnection, ToolDefinition } from '@winsendotai/ovo-contracts';
import { ToolSchemaError } from '../../plugin-kit/src/tool-errors.ts';
import { createMcpConnector, type McpConnector } from '../src/index.ts';
import { poolFixture } from './pool-fixture.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const connection: ToolConnection = {
  id: 'c',
  workspaceId: 'w',
  label: 'MCP',
  endpoint: 'https://mcp.example.test/mcp',
  auth: 'none',
};
async function setup(extra = {}) {
  const fixture = await poolFixture();
  cleanup.push(fixture.close);
  const connector = createMcpConnector([connection], { network: fixture.network, ...extra });
  cleanup.push(async () => {
    await (connector as McpConnector & { dispose?: () => Promise<void> }).dispose?.();
  });
  const remote = (await connector.discover({ workspaceId: 'w', connectionId: 'c' })).tools[0]!;
  const tool: ToolDefinition = {
    id: 't',
    description: '',
    connector: 'mcp',
    connectionId: 'c',
    remoteName: remote.remoteName,
    schemaDigest: remote.schemaDigest,
    inputSchema: remote.inputSchema,
    effect: 'read',
    confirmation: false,
    timeoutMs: 1_000,
  };
  const invoke = () =>
    connector.invoke(
      tool,
      {},
      { operationId: 'op', workspaceId: 'w', signal: new AbortController().signal },
    );
  return { fixture, connector, tool, invoke };
}
it('two invokes reuse one MCP client and its discovery', async () => {
  const { fixture, invoke } = await setup();
  await invoke();
  await invoke();
  expect(fixture.counts.call).toBe(2);
  expect(fixture.counts.list).toBe(1);
  expect(fixture.counts.initialize).toBe(1);
});
it('revalidates notified discovery and refuses drift as a policy error', async () => {
  const { fixture, invoke } = await setup();
  await fixture.change();
  await vi.waitFor(() => expect(fixture.counts.list).toBe(2));
  await expect(invoke()).rejects.toBeInstanceOf(ToolSchemaError);
  expect(fixture.counts.call).toBe(0);
  expect(fixture.counts.list).toBe(2);
});
it('revalidates on TTL expiry without needing a notification', async () => {
  let now = 0;
  const { fixture, invoke } = await setup({ now: () => now, discoveryTtlMs: 10 });
  await invoke();
  await fixture.change(false);
  now = 11;
  await expect(invoke()).rejects.toBeInstanceOf(ToolSchemaError);
  expect(fixture.counts.call).toBe(1);
  expect(fixture.counts.list).toBe(2);
});

it('checks credentials on every acquire, evicts rotated clients, and refuses revocation', async () => {
  const fixture = await poolFixture();
  cleanup.push(fixture.close);
  let secret = 'first';
  let revoked = false;
  const resolve = vi.fn(async () => {
    if (revoked) throw new Error('sensitive backend reason');
    return secret;
  });
  const connector = createMcpConnector(
    [{ ...connection, auth: 'bearer', credentialId: 'credential' }],
    { network: fixture.network, secrets: { resolve } },
  );
  cleanup.push(() => connector.dispose());
  const request = { workspaceId: 'w', connectionId: 'c' };
  await connector.discover(request);
  secret = 'second';
  await connector.discover(request);
  expect(fixture.counts.initialize).toBe(2);
  expect(fixture.auth).toContain('Bearer first');
  expect(fixture.auth).toContain('Bearer second');
  const requestsBeforeRevocation = fixture.auth.length;
  revoked = true;
  await expect(connector.discover(request)).rejects.toThrow('MCP credential resolution failed');
  expect(fixture.auth).toHaveLength(requestsBeforeRevocation);
  expect(resolve).toHaveBeenCalledTimes(3);
});
it('bounds idle clients by size and TTL and closes on disposal', async () => {
  let now = 0;
  const fixture = await poolFixture();
  cleanup.push(fixture.close);
  const connector = createMcpConnector([connection, { ...connection, id: 'other' }], {
    network: fixture.network,
    now: () => now,
    idleTtlMs: 10,
    maxClients: 1,
  });
  cleanup.push(() => connector.dispose());
  await connector.discover({ workspaceId: 'w', connectionId: 'c' });
  await connector.discover({ workspaceId: 'w', connectionId: 'other' });
  await connector.discover({ workspaceId: 'w', connectionId: 'c' });
  expect(fixture.counts.initialize).toBe(3);
  now = 11;
  await connector.discover({ workspaceId: 'w', connectionId: 'c' });
  expect(fixture.counts.initialize).toBe(4);
  await connector.dispose();
  await expect(connector.discover({ workspaceId: 'w', connectionId: 'c' })).rejects.toThrow(
    'disposed',
  );
});

it('rechecks DNS before a pooled client sends another request', async () => {
  const fixture = await poolFixture();
  cleanup.push(fixture.close);
  let address = '93.184.216.34';
  const connector = createMcpConnector([connection], {
    network: { ...fixture.network, lookup: async () => [{ address, family: 4 }] },
  });
  cleanup.push(() => connector.dispose());
  const remote = (await connector.discover({ workspaceId: 'w', connectionId: 'c' })).tools[0]!;
  address = '10.0.0.1';
  await expect(
    connector.invoke(
      {
        id: 't',
        connector: 'mcp',
        description: '',
        connectionId: 'c',
        remoteName: 'lookup',
        schemaDigest: remote.schemaDigest,
        inputSchema: remote.inputSchema,
        effect: 'read',
        confirmation: false,
        timeoutMs: 1000,
      },
      {},
      { workspaceId: 'w', operationId: 'op', signal: new AbortController().signal },
    ),
  ).rejects.toThrow('private or special-use');
  expect(fixture.counts.call).toBe(0);
});

it('counts an active retired client against the pool cap during credential rotation', async () => {
  const fixture = await poolFixture();
  cleanup.push(fixture.close);
  let secret = 'first';
  const connector = createMcpConnector(
    [{ ...connection, auth: 'bearer', credentialId: 'credential' }],
    { network: fixture.network, secrets: { resolve: async () => secret }, maxClients: 1 },
  );
  cleanup.push(() => connector.dispose());
  const remote = (await connector.discover({ workspaceId: 'w', connectionId: 'c' })).tools[0]!;
  const tool: ToolDefinition = {
    id: 't',
    description: '',
    connector: 'mcp',
    connectionId: 'c',
    remoteName: remote.remoteName,
    inputSchema: remote.inputSchema,
    schemaDigest: remote.schemaDigest,
    effect: 'read',
    confirmation: false,
    timeoutMs: 1000,
  };
  const invoke = () =>
    connector.invoke(
      tool,
      {},
      { operationId: 'op', workspaceId: 'w', signal: new AbortController().signal },
    );
  const release = fixture.holdCalls();
  const first = invoke();
  try {
    await vi.waitFor(() => expect(fixture.counts.call).toBe(1));
    secret = 'second';
    await expect(connector.discover({ workspaceId: 'w', connectionId: 'c' })).rejects.toThrow(
      'capacity',
    );
    expect(fixture.counts.initialize).toBe(1);
  } finally {
    release();
    await first;
  }
  await expect(invoke()).resolves.toEqual({ ok: true });
  expect(fixture.counts.initialize).toBe(2);
});
