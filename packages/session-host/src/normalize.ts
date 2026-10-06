import type {
  AgentConfig,
  AgentVoice,
  Slot,
  SpeechCapabilities,
  VoiceSelection,
} from '@winsendotai/ovo-contracts';
import { manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';

export interface NormalizationBinding {
  id: string;
  provider: string;
  pluginId?: string | null;
}

export interface SessionDefaults {
  engine: string;
  turnDetector?: string;
  /**
   * Selected only for an STT that finalises on a host commit (forceEndpoint without an end-of-turn
   * signal): its local silence is what lets the 'commit' turn strategy end a turn.
   */
  vad?: string;
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
  const source = structuredClone(config);
  const voice: AgentVoice = { textFilters: [], acknowledgements: [], ...source.voice };
  const warnings: string[] = [];
  for (const { field, slot, kind } of LEGACY) {
    if (voice[slot]) continue;
    const bindingId = source.providers[field];
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
  if (!voice.vad && defaults.vad && voice.stt && finalisesOnCommit(registry, voice.stt.plugin)) {
    if (registry.get(defaults.vad)) voice.vad = { plugin: defaults.vad, config: {} };
    else warnings.push(`Optional VAD is not installed: ${defaults.vad}`);
  }
  if (!voice.textFilters.length)
    for (const id of defaults.textFilters ?? []) {
      if (registry.get(id)) voice.textFilters.push({ plugin: id, config: {} });
      else warnings.push(`Optional text filter is not installed: ${id}`);
    }
  return { config: { ...source, voice }, warnings };
}

/** The STT's declared turn signals, as the `turn_signal_missing` release check reads them. */
function finalisesOnCommit(registry: PluginRegistry, pluginId: string): boolean {
  const definition = registry.get(pluginId);
  if (!definition) return false;
  const capabilities = manifestKeys(definition.manifest).manifest.capabilities as
    Partial<SpeechCapabilities> | undefined;
  const signals = capabilities?.turnSignals ?? [];
  return (
    capabilities?.forceEndpoint === true &&
    !signals.includes('end-of-turn') &&
    !signals.includes('utterance-end')
  );
}
