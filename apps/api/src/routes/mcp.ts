import type { FastifyReply, FastifyRequest } from 'fastify';
import { registerMcpDiscoveryRoutes } from './mcp-discovery.ts';
export function registerMcpRoutes(dependencies: any) {
  const {
    app,
    store,
    requireRole,
    McpBody,
    validateMcpEndpoint,
    z,
    Id,
    error,
    ApprovalBody,
    queryPage,
  } = dependencies;
  app.get('/v1/mcp-connections', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    const page = queryPage(request);
    return await store.listMcpConnections(principal.workspaceId, page.limit, page.cursor);
  });
  app.post('/v1/mcp-connections', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'admin'),
      body = McpBody.parse(request.body);
    validateMcpEndpoint(body.endpoint);
    const connection = await store.createMcpConnection({
      ...body,
      workspaceId: principal.workspaceId,
    });
    await store.audit({
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
    const connection = await store.updateMcpConnection(principal.workspaceId, connectionId, body);
    await store.audit({
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
      await store.deleteMcpConnection(principal.workspaceId, connectionId);
      await store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'mcp-connection.delete',
        resourceType: 'mcp-connection',
        resourceId: connectionId,
      });
      return reply.code(204).send();
    },
  );
  registerMcpDiscoveryRoutes(dependencies);
  app.get('/v1/agents/:agentId/mcp-tools', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { agentId } = z.object({ agentId: Id }).parse(request.params);
    if (!(await store.getAgent(principal.workspaceId, agentId)))
      return error(reply, 404, 'not_found', 'Agent not found');
    const page = queryPage(request);
    return await store.listMcpApprovals(principal.workspaceId, agentId, page.limit, page.cursor);
  });
  app.put(
    '/v1/agents/:agentId/mcp-tools/:toolId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'editor'),
        { agentId, toolId } = z
          .object({ agentId: Id, toolId: z.string().min(1).max(120) })
          .parse(request.params),
        body = ApprovalBody.parse(request.body),
        connection = await store.getMcpConnection(principal.workspaceId, body.connectionId),
        discovered =
          connection &&
          (await store.getMcpDiscoveredTool(
            principal.workspaceId,
            body.connectionId,
            body.remoteName,
          ));
      if (!discovered || discovered.removedAt || discovered.schemaDigest !== body.schemaDigest)
        return error(
          reply,
          422,
          'mcp_approval_invalid',
          'Approval must match the latest server-recorded discovery schema',
        );
      const approval = await store.upsertMcpApproval({
        ...body,
        workspaceId: principal.workspaceId,
        agentId,
        toolId,
      });
      await store.audit({
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
      await store.deleteMcpApproval(principal.workspaceId, agentId, toolId);
      await store.audit({
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
