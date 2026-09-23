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
  const simulationPlugins = selected.filter((item) => behaviorGraph.has(item.manifest.id));
  const definitions = new Map(simulationPlugins.map((item) => [item.manifest.id, item]));
  const rows = [
    { id: services.manifest.id },
    ...release.plugins
      .filter((plugin) => definitions.has(plugin.id))
      .map((plugin) => ({
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
