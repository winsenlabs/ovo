import type { ReleaseSelection, ReleaseSelections } from '@winsendotai/ovo-contracts';
import { PluginPinError } from '@winsendotai/ovo-runtime';
import { normalizeAgentConfig } from './normalize.ts';
import type { SessionGraphInput } from './select-session-graph.ts';

const DEFAULT_ENGINE = '@winsendotai/ovo-plugin-voice-session-engine';
const SLOTS = [
  'engine',
  'carrier',
  'stt',
  'tts',
  'llm',
  'vad',
  'turnDetector',
  'audioFilter',
] as const;

export function legacySelections(
  input: Pick<SessionGraphInput, 'registry' | 'defaults'> & {
    release: Pick<SessionGraphInput['release'], 'config' | 'providerBindings'>;
  },
): ReleaseSelections {
  const bindings = Object.fromEntries(
    Object.values(input.release.providerBindings ?? {}).map((binding) => [binding.id, binding]),
  );
  const { config } = normalizeAgentConfig(
    input.release.config,
    input.registry,
    bindings,
    input.defaults ?? { engine: DEFAULT_ENGINE },
  );
  const out: Record<string, ReleaseSelection> = {};
  const add = (
    slot: string,
    plugin: string,
    bindingId: string | undefined,
    config: Record<string, unknown>,
  ) => {
    const definition = input.registry.get(plugin);
    if (!definition) throw new PluginPinError('plugin_not_installed', `${plugin} is not installed`);
    out[slot] = {
      pluginId: plugin,
      version: definition.manifest.version,
      ...(bindingId ? { bindingId } : {}),
      config,
    };
  };
  for (const slot of SLOTS) {
    const selection = config.voice?.[slot];
    if (selection) add(slot, selection.plugin, selection.binding, selection.config);
  }
  config.voice?.textFilters.forEach((selection, index) =>
    add(`textFilter:${index}`, selection.plugin, selection.binding, selection.config),
  );
  return out as ReleaseSelections;
}
