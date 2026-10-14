// Pure helpers shared by the agents list and agent overview: turning a saved `AgentConfig.voice`
// selection and the plugin catalog into the humanised chips the brief asks for, instead of raw
// package IDs (brief §3 Agents list: "Voice stack: compact chips of
// `config.voice.{stt,tts,llm,carrier}.plugin` -> `plugin.ui.label` from `/plugins`").
import type { AgentConfig } from '@winsendotai/ovo-contracts';
import type { PluginOption } from '../../components/plugins/types';

export type VoiceStackChip = { slot: string; label: string };

const STACK_SLOTS = ['stt', 'tts', 'llm', 'carrier'] as const;

export function voiceStackChips(
  voice: AgentConfig['voice'] | undefined,
  plugins: readonly PluginOption[],
): VoiceStackChip[] {
  if (!voice) return [];
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return STACK_SLOTS.flatMap((slot) => {
    const pluginId = voice[slot]?.plugin;
    if (!pluginId) return [];
    const plugin = byId.get(pluginId);
    return [{ slot, label: plugin?.ui?.label ?? pluginId }];
  });
}
