import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ConnectorPolicyError } from '@winsendotai/ovo-plugin-kit';
import { toDiscoveredTool, type McpDiscoveredTool, type RemoteToolShape } from './schema.ts';

export async function discoverTools(
  client: Client,
  signal?: AbortSignal,
): Promise<McpDiscoveredTool[]> {
  const output: McpDiscoveredTool[] = [];
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      signal,
      timeout: 10_000,
      maxTotalTimeout: 10_000,
    });
    for (const tool of result.tools) {
      if (names.has(tool.name))
        throw new ConnectorPolicyError(`MCP server returned duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      output.push(toDiscoveredTool(tool as RemoteToolShape));
      if (output.length > 1_000)
        throw new ConnectorPolicyError('MCP discovery exceeds the 1000-tool limit');
    }
    cursor = result.nextCursor;
    if (!cursor) return output;
  }
  throw new ConnectorPolicyError('MCP discovery exceeds the 20-page limit');
}
