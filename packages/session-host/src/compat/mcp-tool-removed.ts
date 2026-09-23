import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
export const mcpToolRemoved: CompatRule = (input, stage) =>
  input.config.tools.flatMap((tool) => {
    if (tool.connector !== 'mcp' || !input.config.allowedTools.includes(tool.id)) return [];
    const discovered = input.discoveredMcpTools?.find(
      (row) => row.connectionId === tool.connectionId && row.remoteName === tool.remoteName,
    );
    return discovered?.removedAt
      ? [
          issue('mcp_tool_removed', stage, `Allowed MCP tool ${tool.id} was removed`, {
            field: tool.id,
          }),
        ]
      : [];
  });
