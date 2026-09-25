import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SecretResolver, ToolConnection } from '@winsendotai/ovo-contracts';
import { ExecutionPolicyError } from '@winsendotai/ovo-plugin-tools';
import {
  createPinnedFetch,
  type SecureNetworkDependencies,
} from '@winsendotai/ovo-plugin-tools-http';

export interface McpConnectorDependencies {
  secrets?: SecretResolver;
  network?: SecureNetworkDependencies;
}

async function closeQuietly(client: Client, dispose: () => Promise<void>): Promise<void> {
  try {
    await client.close();
  } catch {
    // A stateless server may reject DELETE. The request has already settled.
  } finally {
    await dispose();
  }
}

export async function withMcpClient<T>(
  connection: ToolConnection,
  dependencies: McpConnectorDependencies,
  signal: AbortSignal | undefined,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const policy = await createPinnedFetch(connection.endpoint, dependencies.network);
  const headers = new Headers();
  try {
    if (connection.auth === 'bearer') {
      if (!dependencies.secrets) {
        throw new ExecutionPolicyError('MCP authentication requires a server-side secret resolver');
      }
      let secret: string;
      try {
        secret = await dependencies.secrets.resolve(
          connection.workspaceId,
          connection.credentialId!,
        );
      } catch {
        throw new ExecutionPolicyError('MCP credential resolution failed');
      }
      headers.set('authorization', `Bearer ${secret}`);
    }
  } catch (error) {
    await policy.dispose();
    throw error;
  }

  const transport = new StreamableHTTPClientTransport(new URL(connection.endpoint), {
    requestInit: { headers, signal },
    fetch: policy.fetch as typeof globalThis.fetch,
    reconnectionOptions: {
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 0,
    },
  });
  const client = new Client(
    { name: '@winsendotai/ovo-plugin-tools-mcp', version: '0.1.0' },
    {
      capabilities: {},
      enforceStrictCapabilities: true,
    },
  );
  try {
    await client.connect(transport, { signal, timeout: 10_000, maxTotalTimeout: 10_000 });
    return await use(client);
  } finally {
    await closeQuietly(client, policy.dispose);
  }
}
