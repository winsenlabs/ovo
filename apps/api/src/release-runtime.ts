import { toolDefinitionMatchesDiscovery } from '@winsendotai/ovo-plugin-tools-mcp';
import { Cap, HOST_SESSION_SERVICES, type ReleaseSelections } from '@winsendotai/ovo-contracts';
import { validateGraph, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { AgentDraft, ControlStore } from '@winsendotai/ovo-plugin-storage';
import { exactDefinitions, validatePermittedGraph } from './release-graph.ts';
export { createSessionServicesPlugin, mergeCatalog } from './release-catalog.ts';
export { runRelease } from './release-simulation.ts';

const BEHAVIOR_SERVICE = Cap.behavior;

export async function validateRelease(
  agent: AgentDraft,
  plugins: { id: string; version: string }[],
  store: ControlStore,
  catalog: readonly PluginDefinition[],
  services: PluginDefinition,
  selections?: ReleaseSelections,
) {
  const toolIds = new Set(agent.config.tools.map((tool) => tool.id));
  for (const id of agent.config.allowedTools)
    if (!toolIds.has(id)) throw new Error(`Allowed tool ${id} is not defined`);
  for (const binding of Object.values(agent.config.providers))
    if (!(await store.getProviderBinding(agent.workspaceId, binding)))
      throw new Error(`Provider binding ${binding} is missing`);
  for (const tool of agent.config.tools.filter(
    (item) => item.connector === 'mcp' && agent.config.allowedTools.includes(item.id),
  )) {
    const approval = await store.getMcpApproval(agent.workspaceId, agent.id, tool.id);
    const discovered =
      approval &&
      (await store.getMcpDiscoveredTool(
        agent.workspaceId,
        approval.connectionId,
        approval.remoteName,
      ));
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
  const behaviorGraph = validatePermittedGraph(agent, selected, services, selections, catalog);
  const validationGraph = new Set(behaviorGraph);
  for (const definition of selected)
    if (
      definition.manifest.contractVersion >= 2 &&
      definition.manifest.provides.some((key) => key.split('@')[0] === Cap.engine)
    )
      validationGraph.add(definition.manifest.id);
  const graphDefinitions = [
    ...selected,
    ...catalog.filter(
      (item) =>
        validationGraph.has(item.manifest.id) &&
        !selected.some((locked) => locked.manifest.id === item.manifest.id),
    ),
  ];
  const rows = [
    { id: services.manifest.id },
    ...graphDefinitions
      .filter((definition) => validationGraph.has(definition.manifest.id))
      .map((definition) => ({
        id: definition.manifest.id,
        config: definition.manifest.provides.includes(BEHAVIOR_SERVICE)
          ? { agent: agent.config, workspaceId: agent.workspaceId, sessionId: 'release-validation' }
          : {},
      })),
  ];
  const graph = validateGraph(rows, [services, ...catalog], {
    scope: 'session',
    parentKeys: [...HOST_SESSION_SERVICES, Cap.net],
  });
  if (graph.issues.length) throw new Error(graph.issues.map((issue) => issue.message).join('; '));
  return selected.map((item) => ({ id: item.manifest.id, version: item.manifest.version }));
}
