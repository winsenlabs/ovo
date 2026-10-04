import { AgentConfig, AgentVoice, Mode, ToolDefinition } from '@winsendotai/ovo-contracts';
import { validateSelections } from '@winsendotai/ovo-session-host';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth-service.ts';
import { buildReleaseSelections } from '../release-selections.ts';
import type { ManagementApiOptions } from '../types.ts';
import type { ControlStore, ProviderBinding } from '@winsendotai/ovo-plugin-storage';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';

const CompatBody = z.object({
  voice: AgentVoice.optional(),
  mode: Mode,
  language: z.string().min(1).default('en-IN'),
  tools: z.array(ToolDefinition).default([]),
  campaign: z.object({ amd: z.boolean().optional() }).optional(),
});

export function registerPluginRoutes(input: {
  app: FastifyInstance;
  store: ControlStore;
  catalog: readonly PluginDefinition[];
  options: ManagementApiOptions;
  distributionDefaults?: { engine: string; turnDetector?: string; textFilters?: readonly string[] };
  unavailable?: readonly { id: string; version: string; reason: string }[];
}): void {
  const registry = new PluginRegistry(input.catalog);
  input.app.get('/v1/plugins', async (request) => {
    requireRole(request, 'viewer');
    const { kind } = z.object({ kind: z.string().optional() }).parse(request.query);
    const plugins = registry.project();
    return {
      plugins: kind ? plugins.filter((plugin) => plugin.kind === kind) : plugins,
      unavailable: input.unavailable ?? registry.unavailable(),
    };
  });
  input.app.post('/v1/plugins/compat', async (request) => {
    const principal = requireRole(request, 'editor');
    const body = CompatBody.parse(request.body);
    const config = AgentConfig.parse({
      name: 'Compatibility preview',
      mode: body.mode,
      language: body.language,
      voice: body.voice,
      tools: body.tools,
      allowedTools: body.tools.map((tool) => tool.id),
    });
    const agent = {
      id: 'compat-preview',
      workspaceId: principal.workspaceId,
      config,
      draftVersion: 0,
      createdAt: '',
      updatedAt: '',
    };
    const bindingRows = new Map<string, ProviderBinding>();
    let selections: Awaited<ReturnType<typeof buildReleaseSelections>>;
    try {
      selections = await buildReleaseSelections({
        agent,
        store: input.store,
        registry,
        defaults: input.distributionDefaults ?? {
          engine: '@winsendotai/ovo-plugin-voice-session-engine',
        },
        bindingRows,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Compatibility preview failed';
      return [
        {
          code:
            message.includes('binding') || message.includes('Credential')
              ? 'binding_missing'
              : 'plugin_not_installed',
          severity: 'error',
          stage: 'live',
          message,
        },
      ];
    }
    return validateSelections(
      {
        config,
        selections,
        registry,
        amd: body.campaign?.amd,
        priceCards: config.costPolicy?.priceCards,
        defaults: input.distributionDefaults,
        bindings: Object.fromEntries(bindingRows),
      },
      'live',
    );
  });
}
