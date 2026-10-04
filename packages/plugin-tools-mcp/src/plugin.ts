import { Cap, type SecretResolver, type ToolConnection } from '@winsendotai/ovo-contracts';
import type { McpNetworkDependencies } from './network.ts';
import { definePlugin, type Context, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { createMcpConnector } from './connector.ts';

export function createMcpToolsPlugin(
  connections: readonly ToolConnection[],
  network?: McpNetworkDependencies,
): PluginDefinition {
  const needsSecrets = connections.some((connection) => connection.auth === 'bearer');
  return definePlugin(
    {
      id: '@winsendotai/ovo-plugin-tools-mcp',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: needsSecrets ? [Cap.secrets] : [],
      provides: [Cap.toolMcp],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: ['connections.*.credentialId'],
    },
    (ctx: Context) => {
      const secrets = needsSecrets ? (ctx.get(Cap.secrets) as SecretResolver) : undefined;
      const connector = createMcpConnector(connections, { secrets, network });
      ctx.provide(Cap.toolMcp, connector);
      ctx.fiber.effect(() => () => connector.dispose(), 'close MCP clients');
    },
  );
}
