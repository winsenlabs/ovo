import { toolDefinitionMatchesDiscovery } from '@winsendotai/ovo-plugin-tools-mcp';
import { BEHAVIOR_PLUGIN_IDS } from '@winsendotai/ovo-behaviors';
import type { Behavior, OperationStore, SecretResolver } from '@winsendotai/ovo-contracts';
import {
  compose,
  definePlugin,
  resolveGraph,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import type { AgentDraft, ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

const SYSTEM_PLUGIN_ID = '@winsendotai/ovo-api-session-services';
const BEHAVIOR_SERVICE = 'ovo.behavior';
const MODE_BEHAVIOR_IDS = BEHAVIOR_PLUGIN_IDS as Record<AgentDraft['config']['mode'], string>;

export const createSessionServicesPlugin = (
  operations: OperationStore,
  secrets: SecretResolver,
  observability: unknown,
) =>
  definePlugin(
    {
      id: SYSTEM_PLUGIN_ID,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      provides: ['ovo.operation-store', 'ovo.secret-resolver', 'ovo.observability'],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide('ovo.operation-store', operations);
      ctx.provide('ovo.secret-resolver', secrets);
      ctx.provide('ovo.observability', observability);
    },
  );

export function mergeCatalog(...catalogs: (readonly PluginDefinition[])[]) {
  const merged = new Map<string, PluginDefinition>();
  for (const catalog of catalogs) {
    for (const definition of catalog) {
      const old = merged.get(definition.manifest.id);
      if (old && old.manifest.version !== definition.manifest.version)
        throw new Error(`Conflicting approved versions for ${definition.manifest.id}`);
      merged.set(definition.manifest.id, definition);
    }
  }
  return [...merged.values()];
}

function exactDefinitions(
  lock: { id: string; version: string }[],
  catalog: readonly PluginDefinition[],
) {
  return lock.map((pinned) => {
    const definition = catalog.find((item) => item.manifest.id === pinned.id);
    if (!definition || definition.manifest.version !== pinned.version)
      throw new Error(`Pinned plugin is not installed: ${pinned.id}@${pinned.version}`);
    return definition;
  });
}

function validatePermittedGraph(
  agent: AgentDraft,
  selected: readonly PluginDefinition[],
  services: PluginDefinition,
) {
  for (const definition of selected) {
    if (definition.manifest.scope !== 'session')
      throw new Error(`Release plugin must be session scoped: ${definition.manifest.id}`);
  }
  const behaviors = selected.filter((item) => item.manifest.provides.includes(BEHAVIOR_SERVICE));
  if (behaviors.length !== 1)
    throw new Error('Release must select exactly one ovo.behavior provider');
  const behavior = behaviors[0]!;
  if (behavior.manifest.id !== MODE_BEHAVIOR_IDS[agent.config.mode])
    throw new Error(
      `Behavior ${behavior.manifest.id} is incompatible with mode ${agent.config.mode}`,
    );

  const reachable = new Set<string>();
  const visit = (definition: PluginDefinition) => {
    if (reachable.has(definition.manifest.id)) return;
    reachable.add(definition.manifest.id);
    for (const service of definition.manifest.requires) {
      if (services.manifest.provides.includes(service)) continue;
      const providers = selected.filter((item) => item.manifest.provides.includes(service));
      if (providers.length !== 1)
        throw new Error(`Release requires exactly one selected provider for ${service}`);
      visit(providers[0]!);
    }
  };
  visit(behavior);
  const unrelated = selected.find((item) => !reachable.has(item.manifest.id));
  if (unrelated)
    throw new Error(
      `Release plugin is not a permitted behavior dependency: ${unrelated.manifest.id}`,
    );
}

export function validateRelease(
  agent: AgentDraft,
  plugins: { id: string; version: string }[],
  store: ControlStore,
  catalog: readonly PluginDefinition[],
  services: PluginDefinition,
) {
  const toolIds = new Set(agent.config.tools.map((tool) => tool.id));
  for (const id of agent.config.allowedTools)
    if (!toolIds.has(id)) throw new Error(`Allowed tool ${id} is not defined`);
  for (const binding of Object.values(agent.config.providers))
    if (!store.getProviderBinding(agent.workspaceId, binding))
      throw new Error(`Provider binding ${binding} is missing`);
  for (const tool of agent.config.tools.filter(
    (item) => item.connector === 'mcp' && agent.config.allowedTools.includes(item.id),
  )) {
    const approval = store.getMcpApproval(agent.workspaceId, agent.id, tool.id);
    const discovered =
      approval &&
      store
        .listMcpDiscoveredTools(agent.workspaceId, approval.connectionId)
        .find((item) => item.remoteName === approval.remoteName);
    if (
      !approval ||
      tool.connectionId !== approval.connectionId ||
      tool.remoteName !== approval.remoteName ||
      tool.schemaDigest !== approval.schemaDigest ||
      !discovered ||
      discovered.schemaDigest !== approval.schemaDigest ||
      !toolDefinitionMatchesDiscovery(tool, {
        remoteName: discovered.remoteName,
        inputSchema: discovered.inputSchema,
        outputSchema: discovered.outputSchema ?? undefined,
        schemaDigest: discovered.schemaDigest,
      })
    )
      throw new Error(`MCP tool ${tool.id} is not currently approved`);
  }

  const selected = exactDefinitions(plugins, catalog);
  validatePermittedGraph(agent, selected, services);
  const graph = resolveGraph(
    [{ id: services.manifest.id }, ...plugins.map((plugin) => ({ id: plugin.id }))],
    [services, ...catalog],
  );
  return graph
    .filter((item) => item.manifest.id !== services.manifest.id)
    .map((item) => ({ id: item.manifest.id, version: item.manifest.version }));
}

export async function runRelease(
  release: ReleaseRecord,
  catalog: readonly PluginDefinition[],
  services: PluginDefinition,
  input: string,
  variables: Record<string, unknown>,
  sessionId: string,
) {
  const selected = exactDefinitions(release.plugins, catalog);
  validatePermittedGraph(
    {
      id: release.agentId,
      workspaceId: release.workspaceId,
      config: release.config,
      draftVersion: release.draftVersion,
      createdAt: release.createdAt,
      updatedAt: release.createdAt,
    },
    selected,
    services,
  );
  const definitions = new Map(selected.map((item) => [item.manifest.id, item]));
  const rows = [
    { id: services.manifest.id },
    ...release.plugins.map((plugin) => ({
      id: plugin.id,
      config: definitions.get(plugin.id)!.manifest.provides.includes(BEHAVIOR_SERVICE)
        ? {
            agent: structuredClone(release.config),
            workspaceId: release.workspaceId,
            sessionId,
          }
        : {},
    })),
  ];
  const composition = await compose(rows, [services, ...selected]);
  try {
    const behavior = composition.ctx.get(BEHAVIOR_SERVICE) as Behavior | undefined;
    if (!behavior) throw new Error(`Release composition does not provide ${BEHAVIOR_SERVICE}`);
    return await behavior.respond(input, variables);
  } finally {
    await composition.dispose();
  }
}
