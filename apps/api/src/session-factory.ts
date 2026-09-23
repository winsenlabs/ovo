import {
  createSessionPluginCatalog,
  type InstalledNativeHandlerPackage,
} from '@winsendotai/ovo-session-host';
import type {
  AgentDraft,
  ControlStore,
  ProviderBinding,
  ReleaseRecord,
} from '@winsendotai/ovo-plugin-storage';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import type { NativeToolHandler } from '@winsendotai/ovo-plugin-tools';
import type { ToolConnection } from '@winsendotai/ovo-contracts';

export interface DefaultSessionOptions {
  nativeHandlers?: Readonly<Record<string, NativeToolHandler>>;
  nativeHandlerPackages?: readonly InstalledNativeHandlerPackage[];
  inferencePlugin?: (agent: AgentDraft) => PluginDefinition;
}

export function createDefaultReleaseFactory(
  store: ControlStore,
  options: DefaultSessionOptions = {},
) {
  return async ({
    agent,
    release,
    fixtureBindings,
  }: {
    agent: AgentDraft;
    sessionId: string;
    release?: ReleaseRecord;
    fixtureBindings?: boolean;
  }) => {
    const bindings: Record<string, ProviderBinding> = {};
    for (const [role, id] of Object.entries(agent.config.providers)) {
      const binding = release
        ? release.providerBindings[role]
        : await store.getProviderBinding(agent.workspaceId, id);
      if (!binding || binding.id !== id || binding.workspaceId !== agent.workspaceId)
        throw new Error(`Provider binding snapshot is unavailable: ${role}`);
      if (!fixtureBindings)
        await credentialReady(store, agent, binding.credentialId, binding.environment);
      bindings[role] = binding;
    }
    const connections: ToolConnection[] = [];
    const ids = new Set<string>();
    for (const tool of agent.config.tools.filter((tool) =>
      agent.config.allowedTools.includes(tool.id),
    )) {
      if (!fixtureBindings && tool.http?.credentialId)
        await credentialReady(store, agent, tool.http.credentialId);
      if (tool.connector !== 'mcp' || !tool.connectionId || ids.has(tool.connectionId)) continue;
      ids.add(tool.connectionId);
      const connection = release
        ? release.mcpTools[tool.id]?.connection
        : await store.getMcpConnection(agent.workspaceId, tool.connectionId);
      if (!connection || connection.status !== 'ready')
        throw new Error(`MCP connection is not ready: ${tool.connectionId}`);
      if (!fixtureBindings && connection.credentialId)
        await credentialReady(store, agent, connection.credentialId);
      connections.push({ ...connection, credentialId: connection.credentialId ?? undefined });
    }
    return createSessionPluginCatalog({
      config: agent.config,
      workspaceId: agent.workspaceId,
      bindings,
      mcpConnections: connections,
      nativeHandlers: options.nativeHandlers,
      nativeHandlerPackages: options.nativeHandlerPackages,
      releasePlugins: release?.plugins,
      inferencePlugin: options.inferencePlugin?.(agent),
      output: { kind: 'simulation' },
    });
  };
}

async function credentialReady(
  store: ControlStore,
  agent: AgentDraft,
  id: string,
  environment?: string,
) {
  const credential = await store.getCredential(agent.workspaceId, id);
  if (!credential || credential.status !== 'active')
    throw new Error('A required credential is unavailable');
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())
    throw new Error('A required credential expired');
  if (environment && credential.environment !== environment)
    throw new Error('Provider credential environment mismatch');
  if (credential.permittedAgentIds.length && !credential.permittedAgentIds.includes(agent.id))
    throw new Error('A credential does not permit this agent');
}
