'use client';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api';
import type { AgentVoice, CompatIssue, PluginOption, Slot } from './types';
import { pluginOptionsForSlot } from './types';

const SLOT_LABELS: Partial<Record<Slot, string>> = {
  turnDetector: 'Turn detector',
  decision: 'Decision model',
  knowledge: 'Knowledge',
  audioFilter: 'Audio filter',
};

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
  return (
    <fieldset className="slot-picker">
      <legend>{SLOT_LABELS[slot] ?? slot.toUpperCase()}</legend>
      <div className="slot-cards">
        {options.map((plugin) => {
          const reason = reasons[plugin.id] || (!plugin.available ? plugin.unavailableReason : '');
          const reasonId = `reason-${slot}-${plugin.id.replace(/[^a-z0-9-]/gi, '-')}`;
          return (
            <label key={plugin.id} className={`slot-card ${reason ? 'incompatible' : ''}`}>
              <input
                type="radio"
                name={`slot-${slot}`}
                value={plugin.id}
                checked={value === plugin.id}
                disabled={Boolean(reason)}
                aria-describedby={reason ? reasonId : undefined}
                onChange={() => onChange(plugin.id)}
              />
              <span>
                <strong>{plugin.ui?.label ?? plugin.id}</strong>
                <small>
                  {plugin.ui?.vendor ?? plugin.provider ?? 'OVO'} · {plugin.version}
                </small>
                {plugin.capabilities && (
                  <span className="capability-chips">
                    {Object.keys(plugin.capabilities)
                      .slice(0, 4)
                      .map((key) => (
                        <span className="badge soft" key={key}>
                          {key}
                        </span>
                      ))}
                  </span>
                )}
                {reason && (
                  <small id={reasonId} className="field-error">
                    {reason}
                  </small>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
