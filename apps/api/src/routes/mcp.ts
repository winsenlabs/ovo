import type { McpConnection } from '@winsendotai/ovo-plugin-storage';
import type { FastifyReply, FastifyRequest } from 'fastify';
export function registerMcpRoutes(dependencies: any) {
  const {
    app,
    store,
    secrets,
    requireRole,
    McpBody,
    validateMcpEndpoint,
    z,
    Id,
    error,
    createMcpConnector,
    ApprovalBody,
  } = dependencies;
  app.get('/v1/mcp-connections', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    return { items: store.listMcpConnections(principal.workspaceId), nextCursor: null };
  });
  app.post('/v1/mcp-connections', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'admin'),
      body = McpBody.parse(request.body);
    validateMcpEndpoint(body.endpoint);
    const connection = store.createMcpConnection({ ...body, workspaceId: principal.workspaceId });
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'mcp-connection.create',
      resourceType: 'mcp-connection',
      resourceId: connection.id,
      payload: {
        endpoint: connection.endpoint,
        auth: connection.auth,
        credentialId: connection.credentialId,
      },
    });
    return reply.code(201).send(connection);
  });
  app.put('/v1/mcp-connections/:connectionId', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'admin'),
      { connectionId } = z.object({ connectionId: Id }).parse(request.params),
      body = McpBody.parse(request.body);
    validateMcpEndpoint(body.endpoint);
    const connection = store.updateMcpConnection(principal.workspaceId, connectionId, body);
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'mcp-connection.update',
      resourceType: 'mcp-connection',
      resourceId: connectionId,
      payload: {
        endpoint: connection.endpoint,
        auth: connection.auth,
        credentialId: connection.credentialId,
      },
    });
    return connection;
  });
  app.delete(
    '/v1/mcp-connections/:connectionId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'admin'),
        { connectionId } = z.object({ connectionId: Id }).parse(request.params);
      store.deleteMcpConnection(principal.workspaceId, connectionId);
      store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'mcp-connection.delete',
        resourceType: 'mcp-connection',
        resourceId: connectionId,
      });
      return reply.code(204).send();
    },
  );
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
        connection = store.getMcpConnection(principal.workspaceId, connectionId);
      if (!connection) return error(reply, 404, 'not_found', 'MCP connection not found');
      try {
        const discovered = await mcpConnector(connection).discover({
          workspaceId: principal.workspaceId,
          connectionId,
        });
        store.setMcpConnectionStatus(principal.workspaceId, connectionId, 'ready');
        store.audit({
          workspaceId: principal.workspaceId,
          actorId: principal.identityId,
          action: 'mcp-connection.test',
          resourceType: 'mcp-connection',
          resourceId: connectionId,
          payload: { ok: true, toolCount: discovered.tools.length },
        });
        return { ok: true, toolCount: discovered.tools.length };
      } catch (cause) {
        store.setMcpConnectionStatus(principal.workspaceId, connectionId, 'error');
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
        connection = store.getMcpConnection(principal.workspaceId, connectionId);
      if (!connection) return error(reply, 404, 'not_found', 'MCP connection not found');
      try {
        const discovered = await mcpConnector(connection).discover({
          workspaceId: principal.workspaceId,
          connectionId,
        });
        const stored = store.replaceMcpDiscoveredTools(
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
        store.setMcpConnectionStatus(principal.workspaceId, connectionId, 'ready');
        store.audit({
          workspaceId: principal.workspaceId,
          actorId: principal.identityId,
          action: 'mcp-connection.discover',
          resourceType: 'mcp-connection',
          resourceId: connectionId,
          payload: { toolCount: stored.length },
        });
        return { items: stored, nextCursor: null };
      } catch (cause) {
        store.setMcpConnectionStatus(principal.workspaceId, connectionId, 'error');
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
      if (!store.getMcpConnection(principal.workspaceId, connectionId))
        return error(reply, 404, 'not_found', 'MCP connection not found');
      return {
        items: store.listMcpDiscoveredTools(principal.workspaceId, connectionId),
        nextCursor: null,
      };
    },
  );
  app.get('/v1/agents/:agentId/mcp-tools', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { agentId } = z.object({ agentId: Id }).parse(request.params);
    if (!store.getAgent(principal.workspaceId, agentId))
      return error(reply, 404, 'not_found', 'Agent not found');
    return { items: store.listMcpApprovals(principal.workspaceId, agentId), nextCursor: null };
  });
  app.put(
    '/v1/agents/:agentId/mcp-tools/:toolId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'editor'),
        { agentId, toolId } = z
          .object({ agentId: Id, toolId: z.string().min(1).max(120) })
          .parse(request.params),
        body = ApprovalBody.parse(request.body),
        connection = store.getMcpConnection(principal.workspaceId, body.connectionId),
        discovered =
          connection &&
          store
            .listMcpDiscoveredTools(principal.workspaceId, body.connectionId)
            .find(
              (tool: any) =>
                tool.remoteName === body.remoteName && tool.schemaDigest === body.schemaDigest,
            );
      if (!discovered)
        return error(
          reply,
          422,
          'mcp_approval_invalid',
          'Approval must match the latest server-recorded discovery schema',
        );
      const approval = store.upsertMcpApproval({
        ...body,
        workspaceId: principal.workspaceId,
        agentId,
        toolId,
      });
      store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'mcp-tool.approve',
        resourceType: 'agent',
        resourceId: agentId,
        payload: { toolId, connectionId: body.connectionId, schemaDigest: body.schemaDigest },
      });
      return approval;
    },
  );
  app.delete(
    '/v1/agents/:agentId/mcp-tools/:toolId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'editor'),
        { agentId, toolId } = z
          .object({ agentId: Id, toolId: z.string().min(1).max(120) })
          .parse(request.params);
      store.deleteMcpApproval(principal.workspaceId, agentId, toolId);
      store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'mcp-tool.revoke',
        resourceType: 'agent',
        resourceId: agentId,
        payload: { toolId },
      });
      return reply.code(204).send();
    },
  );
}
