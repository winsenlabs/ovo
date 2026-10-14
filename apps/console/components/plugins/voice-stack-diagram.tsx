import type { AgentVoice, PluginOption, Slot } from './types';

const STAGES: readonly { slot: Slot; label: string }[] = [
  { slot: 'carrier', label: 'Carrier' },
  { slot: 'vad', label: 'VAD / Turn' },
  { slot: 'stt', label: 'Speech to text' },
  { slot: 'decision', label: 'Decision / LLM' },
  { slot: 'tts', label: 'Text to speech' },
];

/**
 * Carrier -> VAD/Turn -> STT -> Decision/LLM -> TTS -> Carrier, each node showing the plugin
 * chosen for that slot (brief §3 "Agent plugins" summary bar). Clicking a node jumps to its
 * section below. The "VAD / Turn" and "Decision / LLM" nodes read from whichever of their two
 * slots is actually set — a draft need not use both.
 */
export function VoiceStackDiagram({
  voice,
  plugins,
}: {
  voice: AgentVoice;
  plugins: readonly PluginOption[];
}) {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const labelFor = (slot: Slot) => {
    const pluginId =
      slot === 'vad'
        ? (voice.vad?.plugin ?? voice.turnDetector?.plugin)
        : slot === 'decision'
          ? (voice.decision?.plugin ?? voice.llm?.plugin)
          : voice[slot]?.plugin;
    if (!pluginId) return null;
    return byId.get(pluginId)?.ui?.label ?? pluginId;
  };
  const nodes = [...STAGES, { slot: 'carrier' as const, label: 'Carrier' }];
  return (
    <div className="ds-voice-stack" role="list" aria-label="Voice stack">
      {nodes.map((node, index) => {
        const label = labelFor(node.slot);
        return (
          <span
            key={`${node.slot}-${index}`}
            role="listitem"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            {index > 0 && (
              <span className="ds-voice-stack-arrow" aria-hidden="true">
                →
              </span>
            )}
            <a
              href={`#slot-${node.slot}`}
              className={`ds-voice-stack-node ${label ? '' : 'unset'}`}
            >
              <strong>{node.label}</strong>
              <span>{label ?? 'Not selected'}</span>
            </a>
          </span>
        );
      })}
    </div>
  );
}
