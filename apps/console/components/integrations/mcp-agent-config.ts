import type { AgentConfig, DiscoveredTool, McpConnection } from '../../lib/api';

export function bindDiscoveredMcpTool(
  config: AgentConfig,
  connection: McpConnection,
  tool: DiscoveredTool,
): AgentConfig {
  const definition: AgentConfig['tools'][number] = {
    id: tool.id,
    description: tool.description ?? tool.remoteName,
    connector: 'mcp',
    connectionId: connection.id,
    remoteName: tool.remoteName,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    schemaDigest: tool.schemaDigest,
    effect: tool.effect ?? 'read',
    confirmation: tool.effect === 'write',
    timeoutMs: 10000,
  };
  return {
    ...config,
    tools: [...config.tools.filter((item) => item.id !== tool.id), definition],
    allowedTools: [...new Set([...config.allowedTools, tool.id])],
  };
}
