'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  apiRequest,
  ifMatch,
  items,
  normalizeDraft,
  type AgentDraft,
  type CredentialMetadata,
  type ProviderBinding,
} from '../lib/api';
import { PluginSlotSection } from '../components/plugins/plugin-slot-section';
import { CompatSummary, CompatStatusBadge } from '../components/plugins/compat-summary';
import { VoiceStackDiagram } from '../components/plugins/voice-stack-diagram';
import type { AgentVoice, CompatIssue, PluginCatalog, Slot } from '../components/plugins/types';
import type { PluginOption } from '../components/plugins/types';
import { useSession } from '../components/shell/session-provider';
import { SubPageHeader } from '../components/studio/sub-page-header';
import { SectionCard } from '../components/ui/section-card';
import { ErrorState, InlineAlert, Skeleton } from '../components/ui/feedback-v2';

const slots: Slot[] = [
  'engine',
  'carrier',
  'stt',
  'tts',
  'llm',
  'decision',
  'knowledge',
  'vad',
  'turnDetector',
];
const emptyVoice = (): AgentVoice => ({ textFilters: [], acknowledgements: [] });

export function AgentPluginsFeature({ agentId }: { agentId: string }) {
  const identity = useSession();
  const [draft, setDraft] = useState<AgentDraft>();
  const [savedConfig, setSavedConfig] = useState<string>();
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
      const normalized = normalizeDraft(agent.data, agent.etag);
      setDraft(normalized);
      setSavedConfig(JSON.stringify(normalized.config));
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
  async function saveSecret(plugin: PluginOption, pointer: string, value: string) {
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
        const slot = (Object.keys(previousVoice) as Slot[]).find(
          (key) => previousVoice[key]?.plugin === plugin.id,
        );
        const selection = slot ? previousVoice[slot] : undefined;
        if (!slot || !selection) return current;
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
      const normalized = normalizeDraft(result.data, result.etag);
      setDraft(normalized);
      setSavedConfig(JSON.stringify(normalized.config));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Plugin choices could not be saved');
    } finally {
      setSaving(false);
    }
  }
  const dirty = Boolean(draft && savedConfig && JSON.stringify(draft.config) !== savedConfig);

  if (error && !draft) return <ErrorState message={error} onRetry={load} />;
  if (!draft)
    return (
      <div className="ui-stack">
        <Skeleton shape="block" />
        <Skeleton shape="block" />
      </div>
    );

  const visibleSlots = slots.filter(
    (slot) =>
      slot !== 'llm' || (draft.config.mode !== 'announcement' && draft.config.mode !== 'faq'),
  );

  return (
    <div className="ui-stack">
      <SubPageHeader
        eyebrow="Agent plugins"
        title="Voice & plugins"
        description="Selections are checked against installed manifests and binding metadata."
      />
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <SectionCard
        title="Voice stack"
        actions={<CompatStatusBadge issues={issues} />}
        description="Carrier through speech and decision, back to carrier. Click a node to jump to its slot."
      >
        <VoiceStackDiagram voice={voice} plugins={catalog.plugins} />
      </SectionCard>
      {visibleSlots.map((slot) => (
        <PluginSlotSection
          key={slot}
          slot={slot}
          voice={voice}
          mode={draft.config.mode}
          language={draft.config.language}
          decisionConfigured={Boolean(draft.config.decision?.enabled)}
          knowledgeConfigured={Boolean(draft.config.knowledge?.enabled)}
          plugins={catalog.plugins}
          bindings={bindings}
          credentials={credentials}
          onVoiceChange={updateVoice}
          onBindingCreated={(binding) => setBindings((current) => [...current, binding])}
          onCredentialCreated={(credential) =>
            setCredentials((current) => [...current, credential])
          }
          onSaveSecret={saveSecret}
        />
      ))}
      <SectionCard title="Compatibility">
        <CompatSummary issues={issues} voice={voice} onChange={updateVoice} />
      </SectionCard>
      <div className="ds-save-footer">
        <span className="muted">{dirty ? 'Unsaved changes' : 'Up to date'}</span>
        <div className="ui-cluster">
          {dirty && (
            <button className="button" type="button" onClick={load}>
              Discard
            </button>
          )}
          <button
            className="button primary"
            type="button"
            disabled={saving || identity.role === 'viewer'}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save plugins'}
          </button>
        </div>
      </div>
    </div>
  );
}
