import type { FastifyInstance } from 'fastify';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { behaviorPluginId } from '@winsendotai/ovo-plugin-session';
import { z } from 'zod';
import { requireRole } from '../auth-service.ts';
import { mergeCatalog, validateRelease } from '../release-runtime.ts';
import type { ManagementApiOptions } from '../types.ts';
import type { InfrastructureService } from '../infrastructure-types.ts';
import { liveReadiness } from '../live-readiness.ts';

export function registerReadinessRoutes(input: {
  app: FastifyInstance;
  store: ControlStore;
  options: ManagementApiOptions;
  catalog: readonly PluginDefinition[];
  services: PluginDefinition;
  infrastructure?: InfrastructureService;
}) {
  input.app.get('/v1/agents/:agentId/readiness', async (request) => {
    const principal = requireRole(request, 'viewer');
    const { agentId } = z.object({ agentId: z.string().min(1).max(100) }).parse(request.params);
    const agent = await input.store.getAgent(principal.workspaceId, agentId);
    if (!agent)
      throw Object.assign(new Error('Agent not found'), { statusCode: 404, code: 'not_found' });
    try {
      const generated =
        (await input.options.createReleasePlugins?.({ agent, sessionId: crypto.randomUUID() })) ??
        [];
      const catalog = mergeCatalog(input.catalog, generated);
      const requiredPluginIds = [
        ...new Set([
          behaviorPluginId(agent.config),
          ...generated.map((plugin) => plugin.manifest.id),
        ]),
      ];
      const selected = requiredPluginIds.map((id) => {
        const definition = catalog.find((plugin) => plugin.manifest.id === id);
        if (!definition) throw new Error(`Required plugin is not installed: ${id}`);
        return { id, version: definition.manifest.version };
      });
      await validateRelease(agent, selected, input.store, catalog, input.services);
      const live = await liveReadiness(agent, input.store, input.infrastructure).catch(() => ({
        liveReady: false,
        liveBlockers: ['Current infrastructure readiness could not be verified.'],
      }));
      return {
        releaseReady: true,
        requiredPluginIds,
        blockers: [],
        ...live,
      };
    } catch (error) {
      return {
        releaseReady: false,
        requiredPluginIds: [],
        blockers: [error instanceof Error ? error.message : 'Configuration validation failed'],
        liveReady: false,
      };
    }
  });
}
