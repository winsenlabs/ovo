import { randomUUID } from 'node:crypto';
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
const VOICE_ENGINE_SERVICE = 'ovo.voice-session-engine';
const WORKER_VOICE_PORTS_PLUGIN_ID = '@winsendotai/ovo-api/worker-voice-ports';
const WORKER_VOICE_PORTS = [
  'ovo.media.duplex',
  'ovo.speech-output',
  'ovo.speech-scheduler',
  'ovo.stt',
  'ovo.tts-streaming',
] as const;
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
): Set<string> {
  for (const definition of selected) {
    if (definition.manifest.scope !== 'session')
      throw new Error(`Release plugin must be session scoped: ${definition.manifest.id}`);
  }
  const behaviors = selected.filter((item) => item.manifest.provides.includes(BEHAVIOR_SERVICE));
  if (behaviors.length !== 1)
    throw new Error('Release must select exactly one ovo.behavior provider');
  const behavior = behaviors[0]!;
  const expectedBehavior =
    agent.config.mode === 'faq' && agent.config.faq.some((entry) => entry.requiresTool)
      ? BEHAVIOR_PLUGIN_IDS.faqTools
      : MODE_BEHAVIOR_IDS[agent.config.mode];
  if (behavior.manifest.id !== expectedBehavior)
    throw new Error(
      `Behavior ${behavior.manifest.id} is incompatible with mode ${agent.config.mode}`,
    );
  if (
    (agent.config.mode === 'context' || agent.config.mode === 'agent') &&
    Object.keys(agent.config.providers).length === 0
  )
    throw new Error(`Mode ${agent.config.mode} requires a configured provider binding`);

  const engines = selected.filter((item) => item.manifest.provides.includes(VOICE_ENGINE_SERVICE));
  if (engines.length > 1)
    throw new Error(`Release must select at most one ${VOICE_ENGINE_SERVICE} provider`);
  const workerPorts = new Set<string>(WORKER_VOICE_PORTS);
  const reachable = new Set<string>();
  const visit = (definition: PluginDefinition, allowWorkerPorts: boolean) => {
    if (reachable.has(definition.manifest.id)) return;
    reachable.add(definition.manifest.id);
    for (const service of definition.manifest.requires) {
      const providers = selected.filter((item) => item.manifest.provides.includes(service));
      if (providers.length > 1)
        throw new Error(`Release requires exactly one selected provider for ${service}`);
      if (providers.length === 1) visit(providers[0]!, allowWorkerPorts);
      else if (
        !services.manifest.provides.includes(service) &&
        !(allowWorkerPorts && workerPorts.has(service))
      )
        throw new Error(`Release requires exactly one selected provider for ${service}`);
    }
  };
  visit(behavior, false);
  const behaviorGraph = new Set(reachable);
  for (const engine of engines) visit(engine, true);
  const unrelated = selected.find((item) => !reachable.has(item.manifest.id));
  if (unrelated)
    throw new Error(
      `Release plugin is not a permitted behavior dependency: ${unrelated.manifest.id}`,
    );
  return behaviorGraph;
}

export async function validateRelease(
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
  validatePermittedGraph(agent, selected, services);
  const workerPorts = createWorkerVoicePortsPlugin(selected);
  const graph = resolveGraph(
    [
      { id: services.manifest.id },
      ...(workerPorts ? [{ id: workerPorts.manifest.id }] : []),
      ...plugins.map((plugin) => ({ id: plugin.id })),
    ],
    [services, ...(workerPorts ? [workerPorts] : []), ...catalog],
  );
  return graph
    .filter(
      (item) =>
        item.manifest.id !== services.manifest.id &&
        item.manifest.id !== WORKER_VOICE_PORTS_PLUGIN_ID,
    )
    .map((item) => ({ id: item.manifest.id, version: item.manifest.version }));
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

function createWorkerVoicePortsPlugin(
  selected: readonly PluginDefinition[],
): PluginDefinition | undefined {
  if (!selected.some((item) => item.manifest.provides.includes(VOICE_ENGINE_SERVICE))) return;
  const selectedServices = new Set(selected.flatMap((item) => item.manifest.provides));
  const provides = WORKER_VOICE_PORTS.filter((service) => !selectedServices.has(service));
  return definePlugin(
    {
      id: WORKER_VOICE_PORTS_PLUGIN_ID,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      provides,
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    () => undefined,
  );
}
