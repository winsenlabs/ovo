import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConnectorPolicyError } from '@winsendotai/ovo-plugin-kit';
import type { SecretResolver } from '@winsendotai/ovo-contracts';
import { mcpNetwork, type McpNetworkDependencies } from './network.ts';
import { discoverTools } from './discovery.ts';
import type { McpDiscoveredTool } from './schema.ts';

export interface McpConnectorDependencies {
  secrets?: SecretResolver;
  network?: McpNetworkDependencies;
  idleTtlMs?: number;
  discoveryTtlMs?: number;
  maxClients?: number;
  now?: () => number;
}
export interface PooledClient {
  client: Client;
  tools(signal?: AbortSignal, force?: boolean): Promise<readonly McpDiscoveredTool[]>;
  close(): Promise<void>;
}
export async function connectClient(
  endpoint: string,
  secret: string | undefined,
  dependencies: McpConnectorDependencies,
  signal?: AbortSignal,
): Promise<PooledClient> {
  const net = await mcpNetwork(endpoint, dependencies.network);
  const headers = new Headers(secret === undefined ? {} : { authorization: `Bearer ${secret}` });
  // Per-operation signals belong to SDK requests, never the lifetime of the pooled transport.
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers },
    fetch: net.fetch,
    reconnectionOptions: {
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 0,
    },
  });
  const client = new Client(
    { name: '@winsendotai/ovo-plugin-tools-mcp', version: '0.1.0' },
    { capabilities: {}, enforceStrictCapabilities: true },
  );
  const now = dependencies.now ?? Date.now;
  let generation = 0;
  let cachedGeneration = -1;
  let expiresAt = 0;
  let cached: readonly McpDiscoveredTool[] = [];
  let loading: Promise<readonly McpDiscoveredTool[]> | undefined;

  const close = async () => {
    try {
      await client.close();
    } finally {
      await net.close();
    }
  };
  try {
    await client.connect(transport, { signal, timeout: 10_000, maxTotalTimeout: 10_000 });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  const tools = async (
    signal?: AbortSignal,
    force = false,
  ): Promise<readonly McpDiscoveredTool[]> => {
    if (force) generation += 1;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (cachedGeneration === generation && now() < expiresAt) return cached;
      if (!loading) {
        const requestedGeneration = generation;
        loading = discoverTools(client, signal)
          .then((tools) => {
            cached = tools;
            cachedGeneration = requestedGeneration;
            expiresAt = now() + (dependencies.discoveryTtlMs ?? 300_000);
            return tools;
          })
          .finally(() => {
            loading = undefined;
          });
      }
      await loading;
    }
    throw new ConnectorPolicyError('MCP discovery kept changing during validation');
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    generation += 1;
    // A failed background refresh leaves the generation invalid; the next acquisition fails
    // or refreshes before executing a tool. Never accept stale discovery after a notification.
    void tools().catch(() => undefined);
  });
  return { client, close, tools };
}
