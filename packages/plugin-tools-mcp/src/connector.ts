import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolConnection, ToolConnector } from '@winsendotai/ovo-contracts';
import { ExecutionPolicyError, ToolInvocationError } from '@winsendotai/ovo-plugin-tools';
import {
  mcpSchemaDigest,
  toDiscoveredTool,
  type McpApproval,
  type McpDiscoveredTool,
  type McpDiscovery,
  type McpDiscoveryRequest,
  type RemoteToolShape,
} from './schema.ts';
import { withMcpClient, type McpConnectorDependencies } from './transport.ts';

export interface McpConnector extends ToolConnector {
  /** Read-only discovery. It never changes an agent allowlist or approval. */
  discover(request: McpDiscoveryRequest): Promise<McpDiscovery>;
  validateApproval(approval: McpApproval): Promise<McpDiscoveredTool>;
}

function getConnection(
  connections: ReadonlyMap<string, ToolConnection>,
  workspaceId: string,
  connectionId: string,
): ToolConnection {
  const connection = connections.get(connectionId);
  if (!connection || connection.workspaceId !== workspaceId) {
    throw new ExecutionPolicyError('MCP connection was not found in this workspace');
  }
  return connection;
}

function compileConnections(rows: readonly ToolConnection[]): Map<string, ToolConnection> {
  const connections = new Map<string, ToolConnection>();
  for (const row of rows) {
    if (connections.has(row.id))
      throw new ExecutionPolicyError(`Duplicate MCP connection: ${row.id}`);
    if (row.auth === 'bearer' && !row.credentialId) {
      throw new ExecutionPolicyError(
        `Bearer MCP connection ${row.id} is missing a credential reference`,
      );
    }
    if (row.auth === 'none' && row.credentialId) {
      throw new ExecutionPolicyError(
        `Unauthenticated MCP connection ${row.id} cannot bind a credential`,
      );
    }
    connections.set(row.id, structuredClone(row));
  }
  return connections;
}

async function listToolsWithClient(
  client: Client,
  signal?: AbortSignal,
  timeout = 10_000,
): Promise<McpDiscoveredTool[]> {
  const output: McpDiscoveredTool[] = [];
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      signal,
      timeout,
      maxTotalTimeout: timeout,
    });
    for (const tool of result.tools) {
      if (names.has(tool.name))
        throw new ExecutionPolicyError(`MCP server returned duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      output.push(toDiscoveredTool(tool as RemoteToolShape));
      if (output.length > 1_000)
        throw new ExecutionPolicyError('MCP discovery exceeds the 1000-tool limit');
    }
    cursor = result.nextCursor;
    if (!cursor) return output;
  }
  throw new ExecutionPolicyError('MCP discovery exceeds the 20-page limit');
}

export function createMcpConnector(
  connectionRows: readonly ToolConnection[],
  dependencies: McpConnectorDependencies = {},
): McpConnector {
  const connections = compileConnections(connectionRows);
  const listTools = (connection: ToolConnection, signal?: AbortSignal) =>
    withMcpClient(connection, dependencies, signal, (client) =>
      listToolsWithClient(client, signal),
    );

  return {
    async discover(request) {
      const connection = getConnection(connections, request.workspaceId, request.connectionId);
      return { connectionId: connection.id, tools: await listTools(connection, request.signal) };
    },
    async validateApproval(approval) {
      const connection = getConnection(connections, approval.workspaceId, approval.connectionId);
      const remote = (await listTools(connection)).find(
        (tool) => tool.remoteName === approval.remoteName,
      );
      if (!remote)
        throw new ExecutionPolicyError(`MCP tool is no longer advertised: ${approval.remoteName}`);
      if (remote.schemaDigest !== approval.schemaDigest) {
        throw new ExecutionPolicyError(`MCP schema drift detected for ${approval.remoteName}`);
      }
      return remote;
    },
    async invoke(tool, input, options) {
      if (tool.connector !== 'mcp')
        throw new ExecutionPolicyError(`MCP connector cannot invoke ${tool.connector} tool`);
      if (!tool.connectionId || !tool.remoteName || !tool.schemaDigest) {
        throw new ExecutionPolicyError(
          `MCP tool ${tool.id} is missing connection, remote name, or schema digest`,
        );
      }
      if (input === null || Array.isArray(input) || typeof input !== 'object') {
        throw new ToolInvocationError('MCP tool arguments must be an object', 'not-applied');
      }
      const remoteName = tool.remoteName;
      const connection = getConnection(connections, options.workspaceId, tool.connectionId);
      return withMcpClient(connection, dependencies, options.signal, async (client) => {
        const remote = (await listToolsWithClient(client, options.signal, tool.timeoutMs)).find(
          (candidate) => candidate.remoteName === remoteName,
        );
        if (!remote)
          throw new ToolInvocationError(
            `MCP tool is no longer advertised: ${remoteName}`,
            'not-applied',
          );
        const configuredDigest = mcpSchemaDigest({
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        });
        if (remote.schemaDigest !== tool.schemaDigest || configuredDigest !== tool.schemaDigest) {
          throw new ToolInvocationError(
            `MCP schema drift detected for ${remoteName}`,
            'not-applied',
          );
        }
        if (tool.effect === 'read' && remote.annotations?.readOnlyHint !== true) {
          throw new ToolInvocationError(
            `MCP tool ${remoteName} is not explicitly declared read-only`,
            'not-applied',
          );
        }
        const result = await client.callTool(
          {
            name: remoteName,
            arguments: input as Record<string, unknown>,
          },
          undefined,
          {
            signal: options.signal,
            timeout: tool.timeoutMs,
            maxTotalTimeout: tool.timeoutMs,
          },
        );
        if ('isError' in result && result.isError) {
          throw new ToolInvocationError(`MCP tool ${remoteName} reported an error`, 'unknown');
        }
        if ('toolResult' in result) return structuredClone(result.toolResult);
        return structuredClone(result.structuredContent ?? result.content);
      });
    },
  };
}
