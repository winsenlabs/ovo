import { mcpEndpoint } from './network.ts';
import type { ToolConnection, ToolConnector } from '@winsendotai/ovo-contracts';
import {
  ConnectorPolicyError,
  ToolInvocationError,
  ToolSchemaError,
} from '@winsendotai/ovo-plugin-kit';
import {
  mcpSchemaDigest,
  type McpApproval,
  type McpDiscoveredTool,
  type McpDiscovery,
  type McpDiscoveryRequest,
} from './schema.ts';
import type { McpConnectorDependencies } from './transport.ts';
import { McpClientPool } from './pool.ts';

export interface McpConnector extends ToolConnector {
  dispose(): Promise<void>;
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
    throw new ConnectorPolicyError('MCP connection was not found in this workspace');
  }
  return connection;
}

function compileConnections(rows: readonly ToolConnection[]): Map<string, ToolConnection> {
  const connections = new Map<string, ToolConnection>();
  for (const row of rows) {
    mcpEndpoint(row.endpoint);
    if (connections.has(row.id))
      throw new ConnectorPolicyError(`Duplicate MCP connection: ${row.id}`);
    if (row.auth === 'bearer' && !row.credentialId) {
      throw new ConnectorPolicyError(
        `Bearer MCP connection ${row.id} is missing a credential reference`,
      );
    }
    if (row.auth === 'none' && row.credentialId) {
      throw new ConnectorPolicyError(
        `Unauthenticated MCP connection ${row.id} cannot bind a credential`,
      );
    }
    connections.set(row.id, structuredClone(row));
  }
  return connections;
}

export function createMcpConnector(
  connectionRows: readonly ToolConnection[],
  dependencies: McpConnectorDependencies = {},
): McpConnector {
  const connections = compileConnections(connectionRows);
  const pool = new McpClientPool(dependencies);

  return {
    dispose: () => pool.dispose(),
    async discover(request) {
      const connection = getConnection(connections, request.workspaceId, request.connectionId);
      return {
        connectionId: connection.id,
        tools: await pool.use(connection, request.signal, async (entry) =>
          structuredClone([...(await entry.tools(request.signal, true))]),
        ),
      };
    },
    async validateApproval(approval) {
      const connection = getConnection(connections, approval.workspaceId, approval.connectionId);
      const remote = (
        await pool.use(connection, undefined, (entry) => entry.tools(undefined, true))
      ).find((tool) => tool.remoteName === approval.remoteName);
      if (!remote)
        throw new ConnectorPolicyError(`MCP tool is no longer advertised: ${approval.remoteName}`);
      if (remote.schemaDigest !== approval.schemaDigest) {
        throw new ConnectorPolicyError(`MCP schema drift detected for ${approval.remoteName}`);
      }
      return remote;
    },
    async invoke(tool, input, options) {
      if (tool.connector !== 'mcp')
        throw new ConnectorPolicyError(`MCP connector cannot invoke ${tool.connector} tool`);
      if (!tool.connectionId || !tool.remoteName || !tool.schemaDigest) {
        throw new ConnectorPolicyError(
          `MCP tool ${tool.id} is missing connection, remote name, or schema digest`,
        );
      }
      if (input === null || Array.isArray(input) || typeof input !== 'object') {
        throw new ToolInvocationError('MCP tool arguments must be an object', 'not-applied');
      }
      const remoteName = tool.remoteName;
      const connection = getConnection(connections, options.workspaceId, tool.connectionId);
      return pool.use(connection, options.signal, async (entry) => {
        const remote = (await entry.tools(options.signal)).find(
          (candidate) => candidate.remoteName === remoteName,
        );
        if (!remote) throw new ToolSchemaError(`MCP tool is no longer advertised: ${remoteName}`);
        const configuredDigest = mcpSchemaDigest({
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        });
        if (remote.schemaDigest !== tool.schemaDigest || configuredDigest !== tool.schemaDigest) {
          throw new ToolSchemaError(`MCP schema drift detected for ${remoteName}`);
        }
        if (tool.effect === 'read' && remote.annotations?.readOnlyHint !== true) {
          throw new ConnectorPolicyError(
            `MCP tool ${remoteName} is not explicitly declared read-only`,
          );
        }
        const result = await entry.client.callTool(
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
