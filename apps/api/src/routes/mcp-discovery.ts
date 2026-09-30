import type { McpConnection } from '@winsendotai/ovo-plugin-storage';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function registerMcpDiscoveryRoutes(dependencies: any) {
  const { app, store, secrets, requireRole, z, Id, error, createMcpConnector, queryPage } =
    dependencies;
  const mcpConnector = (connection: McpConnection) =>
    createMcpConnector(
      [
        {
          id: connection.id,
          workspaceId: connection.workspaceId,
          label: connection.label,
          endpoint: connection.endpoint,
          auth: connection.auth,
          credentialId: connection.credentialId ?? undefined,
        },
      ],
      { secrets },
    );
  app.post(
    '/v1/mcp-connections/:connectionId/test',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'admin'),
        { connectionId } = z.object({ connectionId: Id }).parse(request.params),
        connection = await store.getMcpConnection(principal.workspaceId, connectionId);
      if (!connection) return error(reply, 404, 'not_found', 'MCP connection not found');
      try {
        const discovered = await mcpConnector(connection).discover({
          workspaceId: principal.workspaceId,
          connectionId,
        });
        await store.setMcpConnectionStatus(principal.workspaceId, connectionId, 'ready');
        await store.audit({
          workspaceId: principal.workspaceId,
          actorId: principal.identityId,
          action: 'mcp-connection.test',
          resourceType: 'mcp-connection',
          resourceId: connectionId,
          payload: { ok: true, toolCount: discovered.tools.length },
        });
        return { ok: true, toolCount: discovered.tools.length };
      } catch (cause) {
        await store.setMcpConnectionStatus(principal.workspaceId, connectionId, 'error');
        return error(
          reply,
          422,
          'mcp_connection_failed',
          cause instanceof Error ? cause.message : 'MCP connection test failed',
        );
      }
    },
  );
  app.post(
    '/v1/mcp-connections/:connectionId/discover',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'admin'),
        { connectionId } = z.object({ connectionId: Id }).parse(request.params),
        connection = await store.getMcpConnection(principal.workspaceId, connectionId);
      if (!connection) return error(reply, 404, 'not_found', 'MCP connection not found');
      try {
        const discovered = await mcpConnector(connection).discover({
          workspaceId: principal.workspaceId,
          connectionId,
        });
        const stored = await store.replaceMcpDiscoveredTools(
          principal.workspaceId,
          connectionId,
          discovered.tools.map((tool: any) => ({
            remoteName: tool.remoteName,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema ?? null,
            schemaDigest: tool.schemaDigest,
          })),
        );
        await store.setMcpConnectionStatus(principal.workspaceId, connectionId, 'ready');
        await store.audit({
          workspaceId: principal.workspaceId,
          actorId: principal.identityId,
          action: 'mcp-connection.discover',
          resourceType: 'mcp-connection',
          resourceId: connectionId,
          payload: { toolCount: stored.length },
        });
        return { items: stored, nextCursor: null };
      } catch (cause) {
        await store.setMcpConnectionStatus(principal.workspaceId, connectionId, 'error');
        return error(
          reply,
          422,
          'mcp_discovery_failed',
          cause instanceof Error ? cause.message : 'MCP discovery failed',
        );
      }
    },
  );
  app.get(
    '/v1/mcp-connections/:connectionId/tools',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'viewer'),
        { connectionId } = z.object({ connectionId: Id }).parse(request.params);
      if (!(await store.getMcpConnection(principal.workspaceId, connectionId)))
        return error(reply, 404, 'not_found', 'MCP connection not found');
      const page = queryPage(request);
      return await store.listMcpDiscoveredTools(
        principal.workspaceId,
        connectionId,
        page.limit,
        page.cursor,
      );
    },
  );
}
