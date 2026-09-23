import type { MeterDeclaration, ReleaseSelections } from '@winsendotai/ovo-contracts';
import { manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';

export interface SelectedMeter {
  slot: 'carrier' | 'stt' | 'tts' | 'llm';
  pluginId: string;
  meter: MeterDeclaration;
}

/** Required meters for the actual selected roles, with conditional meters evaluated on binding config. */
export function metersFor(
  selections: ReleaseSelections,
  registry: PluginRegistry,
  options: { requiresInput: boolean },
): SelectedMeter[] {
  const slots: readonly ('carrier' | 'stt' | 'tts' | 'llm')[] = options.requiresInput
    ? ['carrier', 'stt', 'tts', 'llm']
    : ['carrier', 'tts', 'llm'];
  const out: SelectedMeter[] = [];
  for (const slot of slots) {
    const selection = selections[slot];
    if (!selection) continue;
    const definition = registry.resolvePin(selection.pluginId, selection.version).definition;
    const binding = selection.binding?.config ?? {};
    for (const meter of manifestKeys(definition.manifest).manifest.meters ?? []) {
      if (meter.role !== slot) continue;
      if (meter.when && !meter.when.in.includes(String(binding[meter.when.field] ?? ''))) continue;
      out.push({ slot, pluginId: definition.manifest.id, meter });
    }
  }
  return out;
}
