'use client';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api';
import type { Choice } from '../ui/choice-card';
import { SlotChoiceCardGroup } from './slot-choice-card';
import { humaniseKey } from '../../lib/status';
import type { AgentVoice, CompatIssue, PluginOption, Slot } from './types';
import { pluginOptionsForSlot } from './types';

export const SLOT_LABELS: Partial<Record<Slot, string>> = {
  engine: 'Engine',
  carrier: 'Carrier',
  stt: 'Speech to text',
  tts: 'Text to speech',
  llm: 'LLM',
  decision: 'Decision model',
  knowledge: 'Knowledge',
  vad: 'Voice activity detection',
  turnDetector: 'Turn detector',
  audioFilter: 'Audio filter',
};

export const REQUIRED_SLOTS: ReadonlySet<Slot> = new Set(['engine', 'carrier', 'stt', 'tts']);

function capabilityChips(plugin: PluginOption): string[] {
  const keys = Object.keys(plugin.capabilities ?? {});
  const shown = keys.slice(0, 4).map(humaniseKey);
  return keys.length > 4 ? [...shown, `+${keys.length - 4}`] : shown;
}

/**
 * One slot's choices as radio cards (brief §3 "Agent plugins": fixes the giant centred radio
 * defect without fighting the global input CSS — `RadioCardGroup` hides the native input but
 * keeps it focusable). Each card's compatibility reason, if any, disables it with an explanation
 * instead of letting an operator pick a plugin that will fail at release time.
 */
export function SlotPicker({
  slot,
  plugins,
  value,
  voice,
  mode,
  language,
  decisionConfigured = false,
  knowledgeConfigured = false,
  onChange,
}: {
  slot: Slot;
  plugins: readonly PluginOption[];
  value?: string;
  voice: AgentVoice;
  mode: 'announcement' | 'faq' | 'context' | 'agent';
  language: string;
  /** True once the agent authors at least one enabled decision question. */
  decisionConfigured?: boolean;
  /** True once the agent enables grounding. */
  knowledgeConfigured?: boolean;
  onChange: (pluginId: string) => void;
}) {
  const options = useMemo(() => pluginOptionsForSlot(plugins, slot), [plugins, slot]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const voiceKey = JSON.stringify(voice);
  useEffect(() => {
    let active = true;
    void Promise.all(
      options.map(async (plugin) => {
        if (!plugin.available)
          return [plugin.id, plugin.unavailableReason ?? 'Plugin unavailable'] as const;
        try {
          const next = {
            ...voice,
            [slot]: { ...(voice[slot] ?? { config: {} }), plugin: plugin.id },
          };
          const { data } = await apiRequest<CompatIssue[]>('/plugins/compat', {
            method: 'POST',
            body: JSON.stringify({ voice: next, mode, language, tools: [] }),
          });
          return [
            plugin.id,
            data.find(
              (issue) =>
                issue.severity === 'error' && (issue.slot === slot || issue.pluginId === plugin.id),
            )?.message ?? '',
          ] as const;
        } catch (error) {
          return [
            plugin.id,
            error instanceof Error ? error.message : 'Compatibility unavailable',
          ] as const;
        }
      }),
    ).then((results) => {
      if (active) setReasons(Object.fromEntries(results));
    });
    return () => {
      active = false;
    };
  }, [options, voiceKey, slot, mode, language]);
  if (slot === 'llm' && (mode === 'announcement' || mode === 'faq')) return null;
  // Picking a decision model before authoring a question selects a metered plugin nothing asks.
  if (slot === 'decision' && !decisionConfigured) return null;
  if (slot === 'knowledge' && !knowledgeConfigured) return null;

  const choices: Choice[] = options.map((plugin) => {
    const reason = reasons[plugin.id] || (!plugin.available ? plugin.unavailableReason : '');
    return {
      value: plugin.id,
      title: plugin.ui?.label ?? plugin.id,
      description: `${plugin.ui?.vendor ?? plugin.provider ?? 'OVO'} · v${plugin.version}`,
      chips: capabilityChips(plugin),
      disabled: Boolean(reason),
      disabledReason: reason || undefined,
    };
  });

  return (
    <SlotChoiceCardGroup
      name={`slot-${slot}`}
      groupLabel={SLOT_LABELS[slot] ?? slot}
      value={value ?? ''}
      choices={choices}
      columns={2}
      onChange={onChange}
    />
  );
}
