import { randomUUID } from 'node:crypto';
import {
  Cap,
  type Behavior,
  type ReleaseSelections,
  type SpeechOutput,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { exactDefinitions, validatePermittedGraph } from './release-graph.ts';

const BEHAVIOR_SERVICE = Cap.behavior;
const simulationUsage = definePlugin(
  {
    id: '@winsendotai/ovo-api/simulation-usage',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'session',
    provides: [Cap.usage],
    requires: [],
    configSchema: { type: 'object', additionalProperties: false },
    secretFields: [],
  },
  (ctx) => {
    ctx.provide(Cap.usage, () => undefined);
  },
);
/** Completes every segment at once. It claims no audio: receipts carry `simulated` evidence. */
const simulationOutput = definePlugin(
  {
    id: '@winsendotai/ovo-api/simulation-speech-output',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'session',
    provides: [Cap.output],
    requires: [],
    configSchema: { type: 'object', additionalProperties: false },
    secretFields: [],
  },
  (ctx) => {
    ctx.provide(Cap.output, {
      play: async () => ({ state: 'completed', evidence: 'simulated' }),
      interrupt: async () => undefined,
    } satisfies SpeechOutput);
  },
);
const OUTPUT_COMPANION = `companion:${Cap.output}` as const;

/**
 * A voice release speaks through its engine's companions, the last of which plays into the call's
 * media. A simulation has no call: the engine is never composed, and the media output is replaced
 * by `simulationOutput`. Without this an agent whose tools narrate through `ovo.speech` (every
 * agent-mode release) could not be simulated at all.
 */
function simulationSelections(selections: ReleaseSelections | undefined) {
  if (!selections?.[OUTPUT_COMPANION]) return selections;
  const { engine: _engine, ...rest } = selections;
  return {
    ...rest,
    [OUTPUT_COMPANION]: {
      pluginId: simulationOutput.manifest.id,
      version: simulationOutput.manifest.version,
      config: {},
    },
  } satisfies ReleaseSelections;
}

export async function runRelease(
  release: ReleaseRecord,
  catalog: readonly PluginDefinition[],
  services: PluginDefinition,
  input: string,
  variables: Record<string, unknown>,
  sessionId: string,
  options: {
    followUpInputs?: string[];
    /** `opening` marks the greet-first turn, which has no caller input. */
    onTurn?: (turn: {
      input: string;
      output: string;
      epoch: number;
      opening: boolean;
    }) => void | Promise<void>;
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
  const selections = simulationSelections(release.selections);
  if (selections !== release.selections) catalog = [...catalog, simulationOutput];
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
    selections,
    catalog,
  );
  const selectedByRelease = new Map(
    Object.values(selections ?? {})
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
  const selectionConfig = (pluginId: string): Record<string, unknown> => {
    const selection = Object.values(selections ?? {}).find((item) => item?.pluginId === pluginId);
    const binding =
      selection?.binding ??
      Object.values(release.providerBindings ?? {}).find((row) => row.id === selection?.bindingId);
    return {
      ...(binding
        ? {
            binding: structuredClone(binding.config ?? {}),
            ...(binding.credentialId
              ? { credentialRef: { credentialId: binding.credentialId } }
              : {}),
          }
        : {}),
      ...structuredClone(selection?.config ?? {}),
    };
  };
  const rows = [
    { id: services.manifest.id },
    { id: simulationUsage.manifest.id },
    ...simulationPlugins.map((plugin) => ({
      id: plugin.manifest.id,
      config: definitions.get(plugin.manifest.id)!.manifest.provides.includes(BEHAVIOR_SERVICE)
        ? {
            agent: structuredClone(release.config),
            workspaceId: release.workspaceId,
            sessionId,
          }
        : selectionConfig(plugin.manifest.id),
    })),
  ];
  const composition = await compose(rows, [services, simulationUsage, ...simulationPlugins]);
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
    let epoch = 0;
    // One turn, played the way the voice engine plays it: each spoken segment gets its own
    // receipt. A behaviour remembers a line only when a receipt matches it exactly, and ends the
    // call only once every line of the goodbye has one, so a single receipt for the joined text
    // would drop a multi-line reply from history and leave a multi-line goodbye unfinished.
    const speak = async (turnInput: string, turnVariables: Record<string, unknown>) => {
      behavior.beginTurn?.(epoch);
      const segments: string[] = [];
      if (behavior.respondStream)
        for await (const segment of behavior.respondStream(turnInput, turnVariables))
          segments.push(segment);
      else segments.push(await behavior.respond(turnInput, turnVariables));
      for (const text of segments)
        behavior.onPlayback?.({
          id: randomUUID(),
          text,
          epoch,
          state: 'completed',
          evidence: 'simulated',
        });
      output = segments.join(' ');
      return epoch++;
    };
    // A greet-first agent speaks before the caller, exactly as the voice engine runs it: one
    // `inputEvent: 'opening'` turn with no caller words. Without it a simulated agent would answer
    // the first input with the opening still unsaid, and its flow would start one state behind.
    if (behavior.speaksFirst?.()) {
      const opened = await speak('', { ...variables, inputEvent: 'opening' });
      await options.onTurn?.({ input: '', output, epoch: opened, opening: true });
      if (behavior.isComplete?.()) return output;
    }
    for (const turnInput of [input, ...(options.followUpInputs ?? [])]) {
      const played = await speak(turnInput, variables);
      await options.onTurn?.({ input: turnInput, output, epoch: played, opening: false });
      if (behavior.isComplete?.()) break;
    }
    return output;
  } finally {
    await composition.dispose();
  }
}
