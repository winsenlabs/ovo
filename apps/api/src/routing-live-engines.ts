import { randomUUID } from 'node:crypto';
import {
  Cap,
  RoutingEngineError,
  type DecisionPort,
  type ExternalDecisionResponse,
  type Inference,
  type RoutingHost,
  type SecretResolver,
} from '@winsendotai/ovo-contracts';
import { compose, manifestKeys, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { exactDefinitions } from './release-graph.ts';
import { releaseSelectionConfig, simulationUsage } from './release-simulation.ts';
import {
  LiveEngineUnavailable,
  type LiveEngineFactory,
  type LiveEngines,
  type LiveEngineRequest,
} from './routing-simulator.ts';

/** The signed webhook client (`callExternalRouteEngine` in the session host), as the factory uses it. */
export type ExternalCaller = (
  options: {
    enabled: boolean;
    workspaceId: string;
    secrets: SecretResolver;
    call: RoutingHost['call'];
    simulated?: boolean;
  },
  input: Parameters<RoutingHost['external']>[0],
  signal: AbortSignal,
) => Promise<ExternalDecisionResponse>;

export interface LiveEngineDependencies {
  store: Pick<ControlStore, 'getRelease'>;
  /** Every installed plugin definition; a release uses the ones it pinned. */
  catalog: readonly PluginDefinition[];
  /** The session services plugin (secrets, operation store) for the router agent. */
  createServices: (agentId?: string) => PluginDefinition;
  /** The credential resolver of one agent: the webhook secret must be allowed for the router agent. */
  secrets?: { forAgent(agentId: string): SecretResolver };
  /** `OVO_ROUTING_EXTERNAL_ENABLED`. */
  externalEnabled: boolean;
  /** Absent, the external engine cannot run live here. */
  callExternal?: ExternalCaller;
}

/** Plugins a selection needs: its own requirements, found among the release's pinned plugins. */
function needed(
  roots: readonly PluginDefinition[],
  pool: readonly PluginDefinition[],
  provided: ReadonlySet<string>,
): PluginDefinition[] {
  const chosen = new Map<string, PluginDefinition>();
  const providers = (key: string) =>
    pool.filter((item) => manifestKeys(item.manifest).provides.some((entry) => entry.key === key));
  const visit = (definition: PluginDefinition) => {
    if (chosen.has(definition.manifest.id)) return;
    chosen.set(definition.manifest.id, definition);
    for (const key of manifestKeys(definition.manifest).requires.map((entry) => entry.key)) {
      if (provided.has(key)) continue;
      const found = providers(key);
      if (found.length !== 1) throw new LiveEngineUnavailable(`requires ${key}`);
      visit(found[0]!);
    }
    for (const { key } of manifestKeys(definition.manifest).optional) {
      const found = provided.has(key) ? [] : providers(key);
      if (found.length === 1) visit(found[0]!);
    }
  };
  roots.forEach(visit);
  return [...chosen.values()];
}

/**
 * Real engines for a route simulation (R4 design 5.4). The decision and LLM engines are composed
 * from the router release's own selections, provider bindings and credentials, the way a text
 * simulation of a release composes them, with a usage sink that records nothing: a live run costs
 * provider money and is neither metered nor budgeted, which is why it is admin-only and flagged
 * off. The external engine posts the same signed webhook the worker does, marked `simulated` with a
 * `sim-` call id. The caller disposes what `open` returns.
 */
export function createLiveEngineFactory(deps: LiveEngineDependencies): LiveEngineFactory {
  return {
    llm: true,
    external: deps.callExternal !== undefined && deps.secrets !== undefined,
    async open(request: LiveEngineRequest) {
      const release = await deps.store.getRelease(request.workspaceId, request.routerReleaseId);
      if (!release) throw new LiveEngineUnavailable('router release not found');
      const ports: LiveEngines = {};
      let dispose = async () => {};
      const slots = (['llm', 'decision'] as const).filter((key) => request.modes[key] === 'live');
      if (slots.length) {
        const services = deps.createServices(release.agentId);
        const pool = [
          ...exactDefinitions(release.plugins, deps.catalog),
          ...Object.values(release.selections ?? {}).flatMap((selection) =>
            deps.catalog.filter((item) => item.manifest.id === selection?.pluginId),
          ),
        ];
        const roots = slots.map((slot) => {
          const selection = release.selections?.[slot];
          if (!selection) throw new LiveEngineUnavailable(`the router release selects no ${slot}`);
          const found = pool.find((item) => item.manifest.id === selection.pluginId);
          if (!found) throw new LiveEngineUnavailable(`${selection.pluginId} is not installed`);
          return found;
        });
        const provided = new Set([
          ...manifestKeys(services.manifest).provides.map((entry) => entry.key),
          ...manifestKeys(simulationUsage.manifest).provides.map((entry) => entry.key),
        ]);
        const graph = needed(roots, pool, provided);
        const composition = await compose(
          [
            { id: services.manifest.id },
            { id: simulationUsage.manifest.id },
            ...graph.map((plugin) => ({
              id: plugin.manifest.id,
              config: releaseSelectionConfig(release, plugin.manifest.id),
            })),
          ],
          [services, simulationUsage, ...graph],
        );
        if (request.modes.llm === 'live')
          ports.inference = composition.ctx.get(Cap.inference) as Inference | undefined;
        if (request.modes.decision === 'live')
          ports.decision = composition.ctx.get(Cap.decision) as DecisionPort | undefined;
        dispose = () => composition.dispose();
        for (const slot of slots) {
          const port = slot === 'llm' ? ports.inference : ports.decision;
          if (!port) {
            await dispose();
            throw new LiveEngineUnavailable(`the router release's ${slot} provides nothing`);
          }
        }
      }
      if (request.modes.external === 'live') {
        if (!deps.callExternal || !deps.secrets) {
          await dispose();
          throw new LiveEngineUnavailable('the external engine is not available here');
        }
        const { callExternal, secrets } = deps;
        const resolver = secrets.forAgent(release.agentId);
        ports.external = (input, signal) => {
          const call = {
            callId: `sim-${randomUUID()}`,
            workspaceId: request.workspaceId,
            routingPointId: request.call.routingPointId,
            routingReleaseId: request.call.routingReleaseId,
            variables: request.call.variables,
            ...(request.call.from ? { from: request.call.from } : {}),
            ...(request.call.to ? { to: request.call.to } : {}),
          };
          return callExternal(
            {
              enabled: deps.externalEnabled,
              workspaceId: request.workspaceId,
              secrets: resolver,
              call,
              simulated: true,
            },
            input,
            signal,
          ).catch((error: unknown) => {
            throw error instanceof RoutingEngineError
              ? error
              : new RoutingEngineError('transport', 'transport');
          });
        };
      }
      return { ports, dispose };
    },
  };
}
