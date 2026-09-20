import type { SecretResolver, ToolConnection } from '@winsendotai/ovo-contracts';
import { serviceKeys } from '@winsendotai/ovo-plugin-tools';
import type { SecureNetworkDependencies } from '@winsendotai/ovo-plugin-tools-http';
import { definePlugin, type Context, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { createMcpConnector } from './connector.ts';

export function createMcpToolsPlugin(
  connections: readonly ToolConnection[],
  network?: SecureNetworkDependencies,
): PluginDefinition {
  const needsSecrets = connections.some((connection) => connection.auth === 'bearer');
  return definePlugin(
    {
      id: '@winsendotai/ovo-plugin-tools-mcp',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: needsSecrets ? [serviceKeys.secretResolver] : [],
      provides: [serviceKeys.connector.mcp],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: ['connections.*.credentialId'],
    },
    (ctx: Context) => {
      const secrets = needsSecrets
        ? (ctx.get(serviceKeys.secretResolver) as SecretResolver)
        : undefined;
      ctx.provide(serviceKeys.connector.mcp, createMcpConnector(connections, { secrets, network }));
    },
  );
}
