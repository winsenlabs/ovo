import type { ReleaseSelections, VoiceSelection } from '@winsendotai/ovo-contracts';
import { normalizeAgentConfig, type SessionDefaults } from '@winsendotai/ovo-session-host';
import { manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import type { AgentDraft, ControlStore, ProviderBinding } from '@winsendotai/ovo-plugin-storage';

const ROLES = [
  ['engine', 'engine'],
  ['carrier', 'carrier'],
  ['stt', 'stt'],
  ['tts', 'tts'],
  ['llm', 'llm'],
  ['vad', 'vad'],
  ['turnDetector', 'turn-detector'],
  ['audioFilter', 'audio-filter'],
] as const;

/** Snapshot every selected binding before the release is written. The draft stays immutable. */
export async function buildReleaseSelections(input: {
  agent: AgentDraft;
  store: ControlStore;
  registry: PluginRegistry;
  defaults: SessionDefaults;
  explicitPluginIds?: readonly string[];
  bindingRows?: Map<string, ProviderBinding>;
}): Promise<ReleaseSelections> {
  const { agent, store, registry } = input;
  const bindingIds = new Set(Object.values(agent.config.providers));
  const voice = agent.config.voice;
  for (const [slot] of ROLES) {
    const choice = voice?.[slot];
    if (choice?.binding) bindingIds.add(choice.binding);
  }
  for (const choice of voice?.textFilters ?? []) if (choice.binding) bindingIds.add(choice.binding);
  const bindings = new Map<string, ProviderBinding>();
  for (const id of bindingIds) {
    if (id === 'env') continue;
    const binding = await store.getProviderBinding(agent.workspaceId, id);
    if (!binding || binding.workspaceId !== agent.workspaceId)
      throw new Error(`Provider binding ${id} is missing`);
    bindings.set(id, binding);
    input.bindingRows?.set(id, binding);
  }
  const normalized = normalizeAgentConfig(
    agent.config,
    registry,
    Object.fromEntries(bindings),
    input.defaults,
  ).config;
  const selected: ReleaseSelections = {};
  const add = async (
    slot: string,
    kind: Parameters<PluginRegistry['resolve']>[0],
    choice: VoiceSelection,
  ) => {
    const definition = registry.resolve(kind, choice.plugin);
    const binding = choice.binding ? bindings.get(choice.binding) : undefined;
    const credential = binding
      ? await store.getCredential(agent.workspaceId, binding.credentialId)
      : undefined;
    if (binding && !credential) throw new Error(`Credential ${binding.credentialId} is missing`);
    selected[slot as keyof ReleaseSelections] = {
      pluginId: definition.manifest.id,
      version: definition.manifest.version,
      ...(choice.binding ? { bindingId: choice.binding } : {}),
      ...(binding && credential
        ? {
            binding: {
              provider: binding.provider,
              config: structuredClone(binding.config),
              credentialId: binding.credentialId,
              fingerprint: credential.fingerprint,
              updatedAt: binding.updatedAt,
            },
          }
        : {}),
      config: structuredClone(choice.config),
    };
  };
  for (const [slot, kind] of ROLES) {
    const choice = normalized.voice?.[slot];
    if (choice) await add(slot, kind, choice);
  }
  for (const [index, choice] of (normalized.voice?.textFilters ?? []).entries())
    await add(`textFilter:${index}`, 'text-filter', choice);

  const explicitEngine = input.explicitPluginIds
    ?.map((id) => registry.get(id))
    .find(
      (definition) => definition && manifestKeys(definition.manifest).manifest.kind === 'engine',
    );
  if (explicitEngine)
    selected.engine = {
      pluginId: explicitEngine.manifest.id,
      version: explicitEngine.manifest.version,
      config: {},
    };
  const engine = selected.engine && registry.get(selected.engine.pluginId);
  if (engine)
    for (const [key, id] of Object.entries(
      manifestKeys(engine.manifest).manifest.companions ?? {},
    )) {
      const companion = registry.get(id, engine.manifest.version);
      if (!companion) throw new Error(`Engine companion ${id} is not installed`);
      selected[`companion:${key}`] = {
        pluginId: companion.manifest.id,
        version: companion.manifest.version,
        config: {},
      };
    }
  // A carrier's control is process-scope; its session selection is still immutable data.
  if (selected.carrier && !registry.get(selected.carrier.pluginId))
    throw new Error(`Carrier ${selected.carrier.pluginId} is not installed`);
  return selected;
}
