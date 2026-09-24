import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { behaviorPluginId } from '@winsendotai/ovo-session-host';
import { validateSelections } from '@winsendotai/ovo-session-host';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import type { CompatIssue } from '@winsendotai/ovo-contracts';
import { buildReleaseSelections } from '../release-selections.ts';

const releaseCode = (message: string): CompatIssue['code'] =>
  /binding|credential/i.test(message)
    ? 'binding_missing'
    : /MCP tool|native handler/i.test(message)
      ? 'mcp_tool_removed'
      : /not installed/i.test(message)
        ? 'plugin_not_installed'
        : 'plugin_unavailable';
const releaseBlockers = (message: string, code: CompatIssue['code'] = releaseCode(message)) => ({
  blockers: [{ code, severity: 'error', stage: 'release', message } satisfies CompatIssue],
});
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
    distributionDefaults,
  } = dependencies;
  app.get('/v1/agents', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    return await store.listAgents(
      principal.workspaceId,
      queryPage(request).limit,
      queryPage(request).cursor,
    );
  });
  app.post('/v1/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'editor'),
      body = AgentBody.parse(request.body),
      agent = await store.createAgent(principal.workspaceId, body.config);
    await store.audit({
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
      agent = await store.getAgent(principal.workspaceId, agentId);
    if (!agent) return error(reply, 404, 'not_found', 'Agent not found');
    return reply.header('etag', etag(agent.draftVersion)).send(agent);
  });
  app.put('/v1/agents/:agentId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'editor'),
      { agentId } = z.object({ agentId: Id }).parse(request.params),
      body = AgentBody.parse(request.body),
      agent = await store.updateAgent(
        principal.workspaceId,
        agentId,
        expectedVersion(request),
        body.config,
      );
    await store.audit({
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
    await store.deleteAgent(principal.workspaceId, agentId, expectedVersion(request));
    await store.audit({
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
    if (!(await store.getAgent(principal.workspaceId, agentId)))
      return error(reply, 404, 'not_found', 'Agent not found');
    const page = queryPage(request);
    return await store.listReleases(principal.workspaceId, agentId, page.limit, page.cursor);
  });
  app.post('/v1/agents/:agentId/releases', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'editor'),
      { agentId } = z.object({ agentId: Id }).parse(request.params),
      body = z.object({ pluginIds: PluginSelection.optional() }).parse(request.body ?? {}),
      agent = await store.getAgent(principal.workspaceId, agentId);
    if (!agent) return error(reply, 404, 'not_found', 'Agent not found');
    let available: PluginDefinition[];
    let generated: readonly PluginDefinition[] = [];
    try {
      generated = (await options.createReleasePlugins?.({ agent, sessionId: randomUUID() })) ?? [];
      available = mergeCatalog(catalog, generated);
    } catch (cause) {
      return reply
        .code(422)
        .send(releaseBlockers(cause instanceof Error ? cause.message : 'Release catalogue failed'));
    }
    const selectedIds = body.pluginIds ?? [
      ...new Set([
        behaviorPluginId(agent.config),
        ...generated.map((plugin) => plugin.manifest.id),
      ]),
    ];
    const unknown = selectedIds.find(
      (id: string) => !available.some((item) => item.manifest.id === id),
    );
    if (unknown)
      return reply
        .code(422)
        .send(releaseBlockers(`Unknown approved plugin: ${unknown}`, 'plugin_not_installed'));
    const selected = selectedIds.map((id: string) => {
      const approved = available.find((item) => item.manifest.id === id)!;
      return { id: approved.manifest.id, version: approved.manifest.version };
    });
    let plugins: { id: string; version: string }[];
    let selections: Awaited<ReturnType<typeof buildReleaseSelections>>;
    try {
      const registry = new PluginRegistry(available);
      const bindingRows = new Map();
      selections = await buildReleaseSelections({
        agent,
        store,
        registry,
        defaults: distributionDefaults ?? {
          engine: '@winsendotai/ovo-plugin-voice-session-engine',
        },
        explicitPluginIds: selectedIds,
        bindingRows,
      });
      const blockers = validateSelections(
        {
          config: agent.config,
          selections,
          registry,
          defaults: distributionDefaults,
          bindings: Object.fromEntries(bindingRows),
        },
        'release',
      ).filter((issue) => issue.severity === 'error');
      if (blockers.length) return reply.code(422).send({ blockers });
      plugins = await validateRelease(agent, selected, store, available, services, selections, {
        plugins: [],
        nativeHandlers: options.defaultSession?.nativeHandlers ?? {},
        nativeHandlerPackages: [...(options.defaultSession?.nativeHandlerPackages ?? [])],
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Release validation failed';
      return reply.code(422).send(releaseBlockers(message));
    }
    const release = await store.createRelease({
      workspaceId: principal.workspaceId,
      agent,
      plugins,
      selections,
      createdBy: principal.identityId,
    });
    await store.audit({
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
      release = await store.getRelease(principal.workspaceId, releaseId);
    return release ?? error(reply, 404, 'not_found', 'Release not found');
  });
}
