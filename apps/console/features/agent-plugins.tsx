'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  apiRequest,
  ifMatch,
  items,
  normalizeDraft,
  type AgentDraft,
  type CredentialMetadata,
  type ProviderBinding,
} from '../lib/api';
import { SlotPicker } from '../components/plugins/slot-picker';
import { BindingSelect } from '../components/plugins/binding-select';
import { SchemaForm } from '../components/plugins/schema-form';
import { CompatSummary } from '../components/plugins/compat-summary';
import type { AgentVoice, CompatIssue, PluginCatalog, Slot } from '../components/plugins/types';
import type { PluginOption } from '../components/plugins/types';
import { useSession } from '../components/shell/session-provider';
import { PageHeader } from '../components/ui/layout';
import { Callout } from '../components/ui/feedback';

const slots: Slot[] = ['engine', 'carrier', 'stt', 'tts', 'llm', 'vad', 'turnDetector'];
const emptyVoice = (): AgentVoice => ({ textFilters: [], acknowledgements: [] });

export function AgentPluginsFeature({ agentId }: { agentId: string }) {
  const identity = useSession();
  const [draft, setDraft] = useState<AgentDraft>();
  const [catalog, setCatalog] = useState<PluginCatalog>({ plugins: [] });
  const [bindings, setBindings] = useState<ProviderBinding[]>([]);
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [issues, setIssues] = useState<CompatIssue[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const [agent, plugins, bindingRows, credentialRows] = await Promise.all([
        apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}`),
        apiRequest<PluginCatalog>('/plugins'),
        apiRequest<unknown>('/provider-bindings'),
        apiRequest<unknown>('/credentials').catch(() => ({ data: { items: [] } })),
      ]);
      setDraft(normalizeDraft(agent.data, agent.etag));
      setCatalog(plugins.data);
      setBindings(items(bindingRows.data));
      setCredentials(items(credentialRows.data));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Agent plugins unavailable');
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);
  const voice = draft?.config.voice ?? emptyVoice();
  const voiceKey = JSON.stringify(voice);
  useEffect(() => {
    if (!draft) return;
    let active = true;
    void apiRequest<CompatIssue[]>('/plugins/compat', {
      method: 'POST',
      body: JSON.stringify({
        voice,
        mode: draft.config.mode,
        language: draft.config.language,
        tools: draft.config.tools,
      }),
    })
      .then(({ data }) => {
        if (active) setIssues(data);
      })
      .catch((failure) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Compatibility unavailable');
      });
    return () => {
      active = false;
    };
  }, [draft?.config.mode, draft?.config.language, voiceKey]);
  const updateVoice = (next: AgentVoice) =>
    setDraft((current) => current && { ...current, config: { ...current.config, voice: next } });
  async function saveSecret(slot: Slot, plugin: PluginOption, pointer: string, value: string) {
    if (!plugin.provider)
      throw new Error('This plugin cannot own a credential without a provider.');
    setError(undefined);
    try {
      const { data } = await apiRequest<CredentialMetadata>('/credentials', {
        method: 'POST',
        body: JSON.stringify({
          label: `${plugin.ui?.label ?? plugin.id} ${pointer.slice(1)} credential`,
          provider: plugin.provider,
          type: plugin.kind,
          environment: 'production',
          value,
          permittedAgentIds: [],
        }),
      });
      if (!data.id) throw new Error('Credential response omitted its id.');
      setCredentials((current) => [...current, data]);
      setDraft((current) => {
        if (!current) return current;
        const previousVoice = current.config.voice ?? emptyVoice();
        const selection = previousVoice[slot];
        if (!selection || selection.plugin !== plugin.id) return current;
        const nextVoice = {
          ...previousVoice,
          [slot]: {
            ...selection,
            config: {
              ...(selection.config ?? {}),
              [pointer.slice(1)]: { credentialRef: { credentialId: data.id } },
            },
          },
        };
        return { ...current, config: { ...current.config, voice: nextVoice } };
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Credential could not be saved');
      throw failure;
    }
  }
  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        headers: { 'if-match': ifMatch(draft.draftVersion) },
        body: JSON.stringify({ config: draft.config }),
      });
      setDraft(normalizeDraft(result.data, result.etag));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Plugin choices could not be saved');
    } finally {
      setSaving(false);
    }
  }
  if (!draft) return <p role="status">{error ?? 'Loading plugin choices…'}</p>;
  return (
    <div className="ui-stack">
      <PageHeader
        eyebrow="Agent plugins"
        title="Choose voice plugins"
        description="Selections are checked against installed manifests and binding metadata."
        actions={
          <button
            className="button primary"
            type="button"
            disabled={saving || identity.role === 'viewer'}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save plugins'}
          </button>
        }
      />
      {error && <Callout tone="danger">{error}</Callout>}
      {slots
        .filter(
          (slot) =>
            slot !== 'llm' || (draft.config.mode !== 'announcement' && draft.config.mode !== 'faq'),
        )
        .map((slot) => {
          const choice = voice[slot];
          const plugin = catalog.plugins.find((item) => item.id === choice?.plugin);
          return (
            <section className="panel" id={`slot-${slot}`} key={slot}>
              <div className="panel-body ui-stack">
                <SlotPicker
                  slot={slot}
                  plugins={catalog.plugins}
                  voice={voice}
                  mode={draft.config.mode}
                  language={draft.config.language}
                  value={choice?.plugin}
                  onChange={(pluginId) =>
                    updateVoice({ ...voice, [slot]: { plugin: pluginId, config: {} } })
                  }
                />
                {plugin && (
                  <Fragment key={plugin.id}>
                    <BindingSelect
                      plugin={plugin}
                      value={choice?.binding}
                      bindings={bindings}
                      credentials={credentials}
                      onChange={(binding) =>
                        updateVoice({ ...voice, [slot]: { ...choice!, binding } })
                      }
                      onCreated={(binding) => setBindings((current) => [...current, binding])}
                      onCredentialCreated={(credential) =>
                        setCredentials((current) => [...current, credential])
                      }
                    />
                    <SchemaForm
                      plugin={plugin}
                      schema={plugin.configSchema}
                      value={choice?.config ?? {}}
                      credentials={credentials}
                      onChange={(config) =>
                        updateVoice({ ...voice, [slot]: { ...choice!, config } })
                      }
                      onSecret={(pointer, secret) => saveSecret(slot, plugin, pointer, secret)}
                    />
                  </Fragment>
                )}
              </div>
            </section>
          );
        })}
      <CompatSummary issues={issues} voice={voice} onChange={updateVoice} />
    </div>
  );
}
