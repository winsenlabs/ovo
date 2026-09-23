import type { AgentConfig, AgentVoice, Slot, VoiceSelection } from '@winsendotai/ovo-contracts';
import { PluginRegistry } from '@winsendotai/ovo-runtime';

export interface NormalizationBinding {
  id: string;
  provider: string;
  pluginId?: string | null;
}

export interface SessionDefaults {
  engine: string;
  turnDetector?: string;
  textFilters?: readonly string[];
}

export interface NormalizedAgentConfig {
  config: AgentConfig;
  warnings: string[];
}

const LEGACY: readonly { field: string; slot: Slot; kind: 'stt' | 'tts' | 'llm' | 'carrier' }[] = [
  { field: 'stt', slot: 'stt', kind: 'stt' },
  { field: 'tts', slot: 'tts', kind: 'tts' },
  { field: 'inference', slot: 'llm', kind: 'llm' },
  { field: 'telephony', slot: 'carrier', kind: 'carrier' },
];

/** Map old provider binding ids to selected plugins, then fill installed distribution defaults. */
export function normalizeAgentConfig(
  config: AgentConfig,
  registry: PluginRegistry,
  bindings: Readonly<Record<string, NormalizationBinding>>,
  defaults: SessionDefaults,
): NormalizedAgentConfig {
  const voice: AgentVoice = { textFilters: [], acknowledgements: [], ...config.voice };
  const warnings: string[] = [];
  for (const { field, slot, kind } of LEGACY) {
    if (voice[slot]) continue;
    const bindingId = config.providers[field];
    if (!bindingId) continue;
    const binding = bindings[bindingId];
    if (!binding) throw new Error(`Legacy ${field} binding is missing: ${bindingId}`);
    const plugin = registry.resolve(kind, binding.pluginId ?? binding.provider);
    (voice as Record<string, VoiceSelection | unknown>)[slot] = {
      plugin: plugin.manifest.id,
      binding: bindingId,
      config: {},
    };
  }
  if (!voice.engine) {
    if (!registry.get(defaults.engine))
      throw new Error(`Default engine is not installed: ${defaults.engine}`);
    voice.engine = { plugin: defaults.engine, config: {} };
  }
  if (!voice.turnDetector && defaults.turnDetector) {
    if (registry.get(defaults.turnDetector))
      voice.turnDetector = { plugin: defaults.turnDetector, config: {} };
    else warnings.push(`Optional turn detector is not installed: ${defaults.turnDetector}`);
  }
  if (!voice.textFilters.length)
    for (const id of defaults.textFilters ?? []) {
      if (registry.get(id)) voice.textFilters.push({ plugin: id, config: {} });
      else warnings.push(`Optional text filter is not installed: ${id}`);
    }
  return { config: { ...config, voice }, warnings };
}
