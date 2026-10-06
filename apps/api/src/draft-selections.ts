import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentDraft, ControlStore, ProviderBinding } from '@winsendotai/ovo-plugin-storage';
import { PluginRegistry, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { SessionDefaults } from '@winsendotai/ovo-session-host';
import { mergeCatalog } from './release-catalog.ts';
import { buildReleaseSelections } from './release-selections.ts';
import { z } from 'zod';
import { requireRole } from './auth-service.ts';
import type { ManagementApiOptions } from './types.ts';

/** What a route that judges an agent's current draft needs. */
export interface DraftRouteInput {
  app: FastifyInstance;
  store: ControlStore;
  options: ManagementApiOptions;
  catalog: readonly PluginDefinition[];
  distributionDefaults?: SessionDefaults;
}

/** The `:agentId` draft a viewer asked about; a 404 error when it is not in their workspace. */
export async function requestedDraft(request: FastifyRequest, store: ControlStore) {
  const principal = requireRole(request, 'viewer');
  const { agentId } = z.object({ agentId: z.string().min(1).max(100) }).parse(request.params);
  const agent = await store.getAgent(principal.workspaceId, agentId);
  if (!agent)
    throw Object.assign(new Error('Agent not found'), { statusCode: 404, code: 'not_found' });
  return agent;
}

/**
 * What a release of the current draft would select: the release-generated plugins merged into
 * the installed catalog, and the provider bindings snapshotted. Shared by the readiness and
 * required-meter routes so both judge the same selection.
 */
export async function draftSelections(input: Omit<DraftRouteInput, 'app'> & { agent: AgentDraft }) {
  const { agent } = input;
  const generated =
    (await input.options.createReleasePlugins?.({ agent, sessionId: crypto.randomUUID() })) ?? [];
  const catalog = mergeCatalog(input.catalog, generated);
  const registry = new PluginRegistry(catalog);
  const bindingRows = new Map<string, ProviderBinding>();
  const selections = await buildReleaseSelections({
    agent,
    store: input.store,
    registry,
    defaults: input.distributionDefaults ?? {
      engine: '@winsendotai/ovo-plugin-voice-session-engine',
    },
    bindingRows,
  });
  return { generated, catalog, registry, bindingRows, selections };
}
