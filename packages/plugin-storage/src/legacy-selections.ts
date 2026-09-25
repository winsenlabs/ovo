import type { PluginKind } from '@winsendotai/ovo-contracts';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import type { ProviderBinding, ReleaseRecord } from './models.ts';

export type LegacyReleaseInput = Pick<ReleaseRecord, 'config' | 'selections'> & {
  providerBindings: Record<string, Pick<ProviderBinding, 'id' | 'provider' | 'pluginId'>>;
};

export interface LegacySelection {
  pluginId: string;
  bindingId?: string;
  config: Record<string, unknown>;
}

const legacySlots = {
  stt: 'stt',
  tts: 'tts',
  inference: 'llm',
  telephony: 'carrier',
} as const;
const kinds: Record<string, PluginKind> = {
  engine: 'engine',
  carrier: 'carrier',
  stt: 'stt',
  tts: 'tts',
  llm: 'llm',
  vad: 'vad',
  turnDetector: 'turn-detector',
  audioFilter: 'audio-filter',
};

/** Reconstructs unpinned choices from a pre-selection release. It never invents a version. */
export function deriveLegacySelections(
  release: LegacyReleaseInput,
  registry: Pick<PluginRegistry, 'resolve' | 'get'>,
  defaults: Partial<Record<string, string>>,
): Record<string, LegacySelection> {
  if (Object.keys(release.selections ?? {}).length) return {};
  const result: Record<string, LegacySelection> = {};
  for (const [legacy, slot] of Object.entries(legacySlots)) {
    const bindingId = release.config.providers[legacy];
    if (!bindingId) continue;
    const binding = release.providerBindings[legacy];
    if (!binding || binding.id !== bindingId)
      throw new Error(`Legacy ${legacy} binding snapshot is missing`);
    const plugin = registry.resolve(kinds[slot]!, binding.pluginId ?? binding.provider);
    result[slot] = { pluginId: plugin.manifest.id, bindingId, config: {} };
  }
  const voice = release.config.voice;
  if (voice) {
    for (const [slot, kind] of Object.entries(kinds)) {
      const choice = voice[slot as keyof typeof voice];
      if (!choice || typeof choice !== 'object' || !('plugin' in choice)) continue;
      const selection = choice as {
        plugin: string;
        binding?: string;
        config: Record<string, unknown>;
      };
      const plugin = registry.resolve(kind, selection.plugin);
      result[slot] = {
        pluginId: plugin.manifest.id,
        ...(selection.binding ? { bindingId: selection.binding } : {}),
        config: selection.config,
      };
    }
    voice.textFilters.forEach((choice, index) => {
      const plugin = registry.resolve('text-filter', choice.plugin);
      result[`textFilter:${index}`] = { pluginId: plugin.manifest.id, config: choice.config };
    });
  }
  for (const [slot, id] of Object.entries(defaults)) {
    if (!id || result[slot] || !kinds[slot]) continue;
    const plugin = registry.get(id);
    if (!plugin && slot === 'engine') throw new Error(`Legacy engine ${id} is not installed`);
    if (plugin) result[slot] = { pluginId: plugin.manifest.id, config: {} };
  }
  return result;
}
