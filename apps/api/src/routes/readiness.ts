import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { behaviorPluginId, validateSelections } from '@winsendotai/ovo-session-host';
import { requireRole } from '../auth-service.ts';
import { validateRelease } from '../release-runtime.ts';
import { draftSelections, requestedDraft, type DraftRouteInput } from '../draft-selections.ts';
import type { InfrastructureService } from '../infrastructure-types.ts';
import { liveReadiness } from '../live-readiness.ts';

export function registerReadinessRoutes(
  input: DraftRouteInput & { services: PluginDefinition; infrastructure?: InfrastructureService },
) {
  input.app.get('/v1/agents/:agentId/readiness', async (request) => {
    const principal = requireRole(request, 'viewer');
    const agent = await requestedDraft(request, input.store);
    try {
      const { generated, catalog, registry, bindingRows, selections } = await draftSelections({
        ...input,
        agent,
      });
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
      await validateRelease(agent, selected, input.store, catalog, input.services, selections, {
        plugins: [],
        nativeHandlers: input.options.defaultSession?.nativeHandlers ?? {},
        nativeHandlerPackages: [...(input.options.defaultSession?.nativeHandlerPackages ?? [])],
      });
      const live = await liveReadiness(
        agent,
        input.store,
        registry,
        selections,
        input.infrastructure,
        Object.fromEntries(bindingRows),
        input.distributionDefaults,
      ).catch(() => ({
        liveReady: false,
        liveBlockers: ['Current infrastructure readiness could not be verified.'],
        details: [
          {
            code: 'plugin_unavailable' as const,
            severity: 'error' as const,
            stage: 'live' as const,
            message: 'Current infrastructure readiness could not be verified.',
          },
        ],
      }));
      let recent: Awaited<ReturnType<ControlStore['getRelease']>> = undefined;
      let cursor: string | undefined;
      do {
        const page = await input.store.listReleases(principal.workspaceId, agent.id, 100, cursor);
        recent = page.items.at(-1) ?? recent;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const immutableIssues = recent
        ? validateSelections(
            {
              config: recent.config,
              selections: recent.selections,
              registry,
              defaults: input.distributionDefaults,
              legacyProviderBindings: recent.providerBindings,
            },
            'live',
          ).filter(
            (issue) =>
              issue.code === 'plugin_version_not_installed' ||
              issue.code === 'legacy_release_unpinned',
          )
        : [];
      const immutableBlockers = immutableIssues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message);
      return {
        releaseReady: true,
        requiredPluginIds,
        blockers: [],
        ...live,
        liveReady: live.liveReady && immutableBlockers.length === 0,
        liveBlockers: [...live.liveBlockers, ...immutableBlockers],
        details: [...live.details, ...immutableIssues],
      };
    } catch (error) {
      return {
        releaseReady: false,
        requiredPluginIds: [],
        blockers: [error instanceof Error ? error.message : 'Configuration validation failed'],
        liveReady: false,
        details: [],
      };
    }
  });
}
