import { randomUUID } from 'node:crypto';
import { Cap, type Behavior } from '@winsendotai/ovo-contracts';
import { compose, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { exactDefinitions, validatePermittedGraph } from './release-graph.ts';

const BEHAVIOR_SERVICE = Cap.behavior;

export async function runRelease(
  release: ReleaseRecord,
  catalog: readonly PluginDefinition[],
  services: PluginDefinition,
  input: string,
  variables: Record<string, unknown>,
  sessionId: string,
  options: {
    followUpInputs?: string[];
    onTurn?: (turn: { input: string; output: string; epoch: number }) => void | Promise<void>;
  } = {},
) {
  if (release.config.mode === 'context' || release.config.mode === 'agent')
    for (const slot of Object.keys(release.config.providers))
      if (!release.providerBindings[slot])
        throw new Error(`Release is missing immutable provider binding snapshot for ${slot}`);
  for (const tool of release.config.tools.filter(
    (candidate) =>
      candidate.connector === 'mcp' && release.config.allowedTools.includes(candidate.id),
  ))
    if (!release.mcpTools[tool.id])
      throw new Error(`Release is missing immutable MCP snapshot for ${tool.id}`);
  const selected = exactDefinitions(release.plugins, catalog);
  const behaviorGraph = validatePermittedGraph(
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
    release.selections,
    catalog,
  );
  const selectedByRelease = new Map(
    Object.values(release.selections ?? {})
      .filter((selection) => selection !== undefined)
      .map((selection) => [selection.pluginId, selection.version]),
  );
  const simulationPlugins = catalog.filter((item) => {
    if (!behaviorGraph.has(item.manifest.id)) return false;
    const pinned = selected.find((definition) => definition.manifest.id === item.manifest.id);
    if (pinned) return pinned.manifest.version === item.manifest.version;
    return selectedByRelease.get(item.manifest.id) === item.manifest.version;
  });
  const definitions = new Map(simulationPlugins.map((item) => [item.manifest.id, item]));
  const rows = [
    { id: services.manifest.id },
    ...simulationPlugins.map((plugin) => ({
      id: plugin.manifest.id,
      config: definitions.get(plugin.manifest.id)!.manifest.provides.includes(BEHAVIOR_SERVICE)
        ? {
            agent: structuredClone(release.config),
            workspaceId: release.workspaceId,
            sessionId,
          }
        : structuredClone(
            Object.values(release.selections ?? {}).find(
              (selection) => selection?.pluginId === plugin.manifest.id,
            )?.config ?? {},
          ),
    })),
  ];
  const composition = await compose(rows, [services, ...simulationPlugins]);
  try {
    const behavior = composition.ctx.get(BEHAVIOR_SERVICE) as
      | (Behavior & {
          beginTurn?: (epoch: number) => void;
          onPlayback?: (event: {
            id: string;
            text: string;
            epoch: number;
            state: 'completed';
            evidence: 'simulated';
          }) => void;
        })
      | undefined;
    if (!behavior) throw new Error(`Release composition does not provide ${BEHAVIOR_SERVICE}`);
    let output = '';
    const inputs = [input, ...(options.followUpInputs ?? [])];
    for (const [epoch, turnInput] of inputs.entries()) {
      behavior.beginTurn?.(epoch);
      output = await behavior.respond(turnInput, variables);
      behavior.onPlayback?.({
        id: randomUUID(),
        text: output,
        epoch,
        state: 'completed',
        evidence: 'simulated',
      });
      await options.onTurn?.({ input: turnInput, output, epoch });
      if (behavior.isComplete?.()) break;
    }
    return output;
  } finally {
    await composition.dispose();
  }
}
