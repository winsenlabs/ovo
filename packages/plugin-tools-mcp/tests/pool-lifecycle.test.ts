import { expect, it } from 'vitest';
import type { ToolConnection } from '@winsendotai/ovo-contracts';
import { McpClientPool } from '../src/pool.ts';
import { poolFixture } from './pool-fixture.ts';
const connection: ToolConnection = {
  id: 'c',
  workspaceId: 'w',
  label: 'MCP',
  endpoint: 'https://mcp.example.test/mcp',
  auth: 'none',
};

it('serializes concurrent first acquisitions into one client and one discovery', async () => {
  const fixture = await poolFixture();
  const pool = new McpClientPool({ network: fixture.network, maxClients: 2 });
  try {
    await Promise.all([
      pool.use(connection, undefined, (client) => client.tools()),
      pool.use(connection, undefined, (client) => client.tools()),
    ]);
    expect(fixture.counts.initialize).toBe(1);
    expect(fixture.counts.list).toBe(1);
  } finally {
    await pool.dispose();
    await fixture.close();
  }
});

it('refuses an acquisition queued before disposal without opening afterward', async () => {
  const fixture = await poolFixture();
  const pool = new McpClientPool({ network: fixture.network });
  const result = pool
    .use(connection, undefined, (client) => client.tools())
    .then(
      () => 'opened',
      () => 'refused',
    );
  await Promise.resolve();
  await pool.dispose();
  try {
    expect(await result).toBe('refused');
    expect(fixture.counts.initialize).toBe(0);
  } finally {
    await pool.dispose();
    await fixture.close();
  }
});
