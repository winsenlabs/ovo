import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import type { FastifyReply, FastifyRequest } from 'fastify';
export function registerAgentsRoutes(dependencies: any) {
  const {
    app,
    store,
    requireRole,
    queryPage,
    AgentBody,
    etag,
    z,
    Id,
    expectedVersion,
    PluginSelection,
    catalog,
    options,
    randomUUID,
    mergeCatalog,
    validateRelease,
    services,
    error,
  } = dependencies;
  app.get('/v1/agents', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    return store.listAgents(
      principal.workspaceId,
      queryPage(request).limit,
      queryPage(request).cursor,
    );
  });
  app.post('/v1/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'editor'),
      body = AgentBody.parse(request.body),
      agent = store.createAgent(principal.workspaceId, body.config);
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'agent.create',
      resourceType: 'agent',
      resourceId: agent.id,
      payload: { mode: agent.config.mode, draftVersion: 1 },
    });
    return reply.code(201).header('etag', etag(agent.draftVersion)).send(agent);
  });
  app.get('/v1/agents/:agentId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { agentId } = z.object({ agentId: Id }).parse(request.params),
      agent = store.getAgent(principal.workspaceId, agentId);
    if (!agent) return error(reply, 404, 'not_found', 'Agent not found');
    return reply.header('etag', etag(agent.draftVersion)).send(agent);
  });
  app.put('/v1/agents/:agentId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'editor'),
      { agentId } = z.object({ agentId: Id }).parse(request.params),
      body = AgentBody.parse(request.body),
      agent = store.updateAgent(
        principal.workspaceId,
        agentId,
        expectedVersion(request),
        body.config,
      );
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'agent.update',
      resourceType: 'agent',
      resourceId: agent.id,
      payload: { draftVersion: agent.draftVersion },
    });
    return reply.header('etag', etag(agent.draftVersion)).send(agent);
  });
  app.delete('/v1/agents/:agentId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'editor'),
      { agentId } = z.object({ agentId: Id }).parse(request.params);
    store.deleteAgent(principal.workspaceId, agentId, expectedVersion(request));
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'agent.delete',
      resourceType: 'agent',
      resourceId: agentId,
    });
    return reply.code(204).send();
  });
  app.get('/v1/agents/:agentId/releases', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { agentId } = z.object({ agentId: Id }).parse(request.params);
    if (!store.getAgent(principal.workspaceId, agentId))
      return error(reply, 404, 'not_found', 'Agent not found');
    return { items: store.listReleases(principal.workspaceId, agentId), nextCursor: null };
  });
  app.post('/v1/agents/:agentId/releases', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'editor'),
      { agentId } = z.object({ agentId: Id }).parse(request.params),
      body = z.object({ pluginIds: PluginSelection }).parse(request.body),
      agent = store.getAgent(principal.workspaceId, agentId);
    if (!agent) return error(reply, 404, 'not_found', 'Agent not found');
    let available: PluginDefinition[];
    try {
      available = mergeCatalog(
        catalog,
        options.createReleasePlugins?.({ agent, sessionId: randomUUID() }) ?? [],
      );
    } catch (cause) {
      return error(
        reply,
        422,
        'release_not_ready',
        cause instanceof Error ? cause.message : 'Release catalogue failed',
      );
    }
    const selected = body.pluginIds.map((id: any) => {
      const approved = available.find((item: any) => item.manifest.id === id);
      if (!approved)
        throw Object.assign(new Error(`Unknown approved plugin: ${id}`), {
          statusCode: 422,
          code: 'release_not_ready',
        });
      return { id: approved.manifest.id, version: approved.manifest.version };
    });
    let plugins: { id: string; version: string }[];
    try {
      plugins = validateRelease(agent, selected, store, available, services);
    } catch (cause) {
      return error(
        reply,
        422,
        'release_not_ready',
        cause instanceof Error ? cause.message : 'Release validation failed',
      );
    }
    const release = store.createRelease({
      workspaceId: principal.workspaceId,
      agent,
      plugins,
      createdBy: principal.identityId,
    });
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'release.create',
      resourceType: 'release',
      resourceId: release.id,
      payload: { agentId, draftVersion: agent.draftVersion, plugins },
    });
    return reply.code(201).send(release);
  });
  app.get('/v1/releases/:releaseId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { releaseId } = z.object({ releaseId: Id }).parse(request.params),
      release = store.getRelease(principal.workspaceId, releaseId);
    return release ?? error(reply, 404, 'not_found', 'Release not found');
  });
}
