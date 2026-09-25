'use client';
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentVoice, Slot } from '@winsendotai/ovo-contracts';
import {
  apiRequest,
  emptyAgentConfig,
  ifMatch,
  normalizeDraft,
  type AgentConfig,
} from '../lib/api';
import { SlotPicker } from '../components/plugins/slot-picker';
import type { PluginCatalog } from '../components/plugins/types';
import { useSession } from '../components/shell/session-provider';
import { PageHeader } from '../components/ui/layout';
import { useResource } from '../lib/data/use-resource';
import { useMutation } from '../lib/data/use-mutation';
import { resources } from '../lib/data/resources';

const wizardSlots: Slot[] = ['engine', 'carrier', 'stt', 'tts', 'llm', 'vad', 'turnDetector'];
const modes: { id: AgentConfig['mode']; label: string; description: string }[] = [
  { id: 'announcement', label: 'Announcement', description: 'Approved message with no LLM' },
  { id: 'faq', label: 'FAQ', description: 'Approved answers to common questions' },
  { id: 'context', label: 'Context', description: 'Conversation grounded in supplied facts' },
  { id: 'agent', label: 'Agent', description: 'Controlled tools and conversation' },
];
export function AgentWizardFeature() {
  const router = useRouter();
  const identity = useSession();
  const workspaceKey =
    identity.workspaceId ?? identity.workspace?.id ?? identity.id ?? identity.email ?? 'unknown';
  const catalogResource = useResource(`plugins:${workspaceKey}`, resources.plugins);
  const catalog: PluginCatalog =
    catalogResource.status === 'ready' ? catalogResource.data : { plugins: [] };
  const invalidates = useMemo(() => [`agents:${workspaceKey}`], [workspaceKey]);
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<AgentConfig>(() => emptyAgentConfig());
  const voice: AgentVoice = config.voice ?? { textFilters: [], acknowledgements: [] };
  const createAgent = useCallback(async (next: AgentConfig) => {
    const initial = await apiRequest<unknown>('/agents', {
      method: 'POST',
      body: JSON.stringify({ config: emptyAgentConfig() }),
    });
    const draft = normalizeDraft(initial.data, initial.etag);
    await apiRequest(`/agents/${encodeURIComponent(draft.id)}`, {
      method: 'PUT',
      headers: { 'if-match': ifMatch(draft.draftVersion) },
      body: JSON.stringify({ config: next }),
    });
    return draft.id;
  }, []);
  const createMutation = useMutation(createAgent, invalidates);
  async function create() {
    try {
      const id = await createMutation.run(config);
      router.push(`/agents/${encodeURIComponent(id)}/plugins`);
    } catch {
      /* The mutation exposes its error. */
    }
  }
  return (
    <div className="ui-stack">
      <PageHeader
        eyebrow="Create agent"
        title="New voice agent"
        description="Name the agent, choose installed plugins, then add the behavior essentials."
      />
      <ol className="ui-cluster" aria-label="Wizard progress">
        <li aria-current={step === 0 ? 'step' : undefined}>1 · Basics</li>
        <li aria-current={step === 1 ? 'step' : undefined}>2 · Plugins</li>
        <li aria-current={step === 2 ? 'step' : undefined}>3 · Behavior</li>
      </ol>
      {catalogResource.status === 'error' && <p role="alert">{catalogResource.error}</p>}
      {createMutation.error && <p role="alert">{createMutation.error}</p>}
      {step === 0 && (
        <section className="panel panel-body ui-stack">
          <label>
            Name
            <input
              value={config.name}
              onChange={(event) =>
                setConfig((current) => ({ ...current, name: event.target.value }))
              }
              required
            />
          </label>
          <label>
            Language
            <input
              value={config.language}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  language: event.target.value,
                  locale: event.target.value,
                }))
              }
              required
            />
          </label>
          <fieldset>
            <legend>Mode</legend>
            <div className="slot-cards">
              {modes.map((mode) => (
                <label key={mode.id} className="slot-card">
                  <input
                    type="radio"
                    name="mode"
                    checked={config.mode === mode.id}
                    onChange={() => setConfig((current) => ({ ...current, mode: mode.id }))}
                  />
                  <span>
                    <strong>{mode.label}</strong>
                    <small>{mode.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>
      )}
      {step === 1 && (
        <div className="ui-stack">
          <p>No carrier is preselected. Choose the one configured for your number when ready.</p>
          {wizardSlots
            .filter(
              (slot) => slot !== 'llm' || (config.mode !== 'announcement' && config.mode !== 'faq'),
            )
            .map((slot) => (
              <SlotPicker
                key={slot}
                slot={slot}
                plugins={catalog.plugins}
                value={voice[slot]?.plugin}
                voice={voice}
                mode={config.mode}
                language={config.language}
                onChange={(plugin) =>
                  setConfig((current) => ({
                    ...current,
                    voice: {
                      ...(current.voice ?? { textFilters: [], acknowledgements: [] }),
                      [slot]: { plugin, config: {} },
                    },
                  }))
                }
              />
            ))}
        </div>
      )}
      {step === 2 && (
        <section className="panel panel-body ui-stack">
          <label>
            {config.mode === 'announcement' ? 'Approved message' : 'Opening message'}
            <textarea
              value={config.message}
              onChange={(event) =>
                setConfig((current) => ({ ...current, message: event.target.value }))
              }
            />
          </label>
          {(config.mode === 'context' || config.mode === 'agent') && (
            <label>
              Grounding context
              <textarea
                value={config.context}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, context: event.target.value }))
                }
              />
            </label>
          )}
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={config.recording}
              onChange={(event) =>
                setConfig((current) => ({ ...current, recording: event.target.checked }))
              }
            />
            Record calls under the configured policy
          </label>
        </section>
      )}
      <div className="ui-cluster">
        {step > 0 && (
          <button className="button" type="button" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < 2 ? (
          <button className="button primary" type="button" onClick={() => setStep(step + 1)}>
            Continue
          </button>
        ) : (
          <button
            className="button primary"
            type="button"
            disabled={createMutation.pending || identity.role === 'viewer' || !config.name.trim()}
            onClick={() => void create()}
          >
            {createMutation.pending ? 'Creating…' : 'Create agent'}
          </button>
        )}
      </div>
    </div>
  );
}
