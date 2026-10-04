import type { AgentDraft, ControlStore } from '@winsendotai/ovo-plugin-storage';

/** Carry tombstones into compatibility checks for every allowed MCP tool. */
export async function discoveredAllowedMcpTools(agent: AgentDraft, store: ControlStore) {
  return Promise.all(
    agent.config.tools
      .filter((tool) => tool.connector === 'mcp' && agent.config.allowedTools.includes(tool.id))
      .map(async (tool) => {
        const found =
          tool.connectionId && tool.remoteName
            ? await store.getMcpDiscoveredTool(
                agent.workspaceId,
                tool.connectionId,
                tool.remoteName,
              )
            : undefined;
        return {
          connectionId: tool.connectionId ?? '',
          remoteName: tool.remoteName ?? '',
          removedAt: found?.removedAt ?? (!found ? 'missing' : null),
        };
      }),
  );
}
