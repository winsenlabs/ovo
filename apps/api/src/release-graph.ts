import { BEHAVIOR_PLUGIN_IDS } from '@winsendotai/ovo-behaviors';
import { Cap, HOST_SESSION_SERVICES, type ReleaseSelections } from '@winsendotai/ovo-contracts';
import { manifestKeys, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { AgentDraft } from '@winsendotai/ovo-plugin-storage';

const BEHAVIOR_SERVICE = Cap.behavior;
const VOICE_ENGINE_SERVICE = Cap.engine;
const MODE_BEHAVIOR_IDS = BEHAVIOR_PLUGIN_IDS as Record<AgentDraft['config']['mode'], string>;

export function exactDefinitions(
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

export function validatePermittedGraph(
  agent: AgentDraft,
  selected: readonly PluginDefinition[],
  services: PluginDefinition,
  selections?: ReleaseSelections,
  catalog: readonly PluginDefinition[] = selected,
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
    Object.keys(agent.config.providers).length === 0 &&
    !selections?.llm?.bindingId
  )
    throw new Error(`Mode ${agent.config.mode} requires a configured provider binding`);

  const engines = selected.filter((item) => item.manifest.provides.includes(VOICE_ENGINE_SERVICE));
  if (engines.length > 1)
    throw new Error(`Release must select at most one ${VOICE_ENGINE_SERVICE} provider`);
  const selectionIds = new Set(
    Object.values(selections ?? {}).flatMap((selection) => (selection ? [selection.pluginId] : [])),
  );
  const selectedDefinitions = catalog.filter((definition) =>
    selectionIds.has(definition.manifest.id),
  );
  for (const id of selectionIds)
    if (!selectedDefinitions.some((definition) => definition.manifest.id === id))
      throw new Error(`Selected plugin is not installed: ${id}`);
  const selectedEngine = selections?.engine
    ? catalog.find((definition) => definition.manifest.id === selections.engine?.pluginId)
    : undefined;
  // A voice LLM release uses the live host output; ordinary simulation releases
  // already selected their simulated output and must not import live companions.
  const companionIds = new Set(
    Object.values(
      agent.config.voice?.llm && selectedEngine
        ? (manifestKeys(selectedEngine.manifest).manifest.companions ?? {})
        : {},
    ),
  );
  const withSelections = [
    ...selected,
    ...selectedDefinitions.filter(
      (definition) =>
        !selected.some((item) => item.manifest.id === definition.manifest.id) &&
        !manifestKeys(definition.manifest).provides.some((service) =>
          selected.some((item) =>
            manifestKeys(item.manifest).provides.some((entry) => entry.key === service.key),
          ),
        ),
    ),
  ];
  const dependencies = [
    ...withSelections,
    ...catalog.filter(
      (definition) =>
        companionIds.has(definition.manifest.id) &&
        !withSelections.some(
          (selectedDefinition) => selectedDefinition.manifest.id === definition.manifest.id,
        ),
    ),
  ];
  const reachable = new Set<string>();
  const visit = (definition: PluginDefinition) => {
    if (reachable.has(definition.manifest.id)) return;
    reachable.add(definition.manifest.id);
    for (const service of definition.manifest.requires) {
      const providers = dependencies.filter((item) =>
        manifestKeys(item.manifest).provides.some((entry) => entry.key === service),
      );
      if (providers.length > 1)
        throw new Error(`Release requires exactly one selected provider for ${service}`);
      if (providers.length === 1) visit(providers[0]!);
      else if (
        !services.manifest.provides.includes(service) &&
        !HOST_SESSION_SERVICES.includes(service as (typeof HOST_SESSION_SERVICES)[number])
      )
        throw new Error(`Release requires exactly one selected provider for ${service}`);
    }
  };
  visit(behavior);
  const behaviorGraph = new Set(reachable);
  // A v1 worker-only engine remains an exact lock. Its live dependencies are checked at
  // admission; release validation never applies it or invents worker speech providers.
  for (const engine of engines) reachable.add(engine.manifest.id);
  for (const definition of selected)
    if (manifestKeys(definition.manifest).manifest.kind === 'engine')
      reachable.add(definition.manifest.id);
  const unrelated = selected.find((item) => !reachable.has(item.manifest.id));
  if (unrelated)
    throw new Error(
      `Release plugin is not a permitted behavior dependency: ${unrelated.manifest.id}`,
    );
  return behaviorGraph;
}
