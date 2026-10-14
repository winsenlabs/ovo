'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useConfirm } from '../ui/dialog';
import {
  apiRequest,
  type CredentialMetadata,
  type ProviderBinding,
  type SessionIdentity,
} from '../../lib/api';
import { SectionCard } from '../ui/section-card';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';
import { ErrorState, InlineAlert } from '../ui/feedback-v2';
import type { PluginCatalog, PluginOption } from '../plugins/types';
import { schemaDefaults } from '../plugins/schema-defaults';
import { BindingsTable } from './bindings-table';
import { BindingEditDrawer } from './binding-edit-drawer';

interface BindingDraft {
  label: string;
  provider: string;
  pluginId: string;
  environment: string;
  credentialId: string;
  configText: string;
}
const emptyDraft = (): BindingDraft => ({
  label: '',
  provider: '',
  pluginId: '',
  environment: 'production',
  credentialId: '',
  configText: '{\n  "model": ""\n}',
});
const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * The Bindings tab of Providers & secrets. The "Create binding" form below is intentionally kept
 * self-contained (it loads its own `/plugins`) so it works the same standalone, which
 * `components/plugins/binding-defaults.test.tsx` (owned by the agents/plugins lane) exercises by
 * mounting `BindingManager` directly.
 */
export function BindingManager({
  bindings,
  bindingsStatus = 'ready',
  bindingsError,
  credentials,
  reload,
  role,
}: {
  bindings: ProviderBinding[];
  bindingsStatus?: 'loading' | 'ready' | 'error';
  bindingsError?: string;
  credentials: CredentialMetadata[];
  reload: () => Promise<void>;
  role: SessionIdentity['role'];
}) {
  const confirm = useConfirm();
  const [plugins, setPlugins] = useState<PluginOption[]>([]);
  useEffect(() => {
    void apiRequest<PluginCatalog>('/plugins')
      .then(({ data }) =>
        setPlugins(
          data.plugins.filter((plugin) =>
            ['carrier', 'stt', 'tts', 'llm', 'decision'].includes(plugin.kind),
          ),
        ),
      )
      .catch(() => undefined);
  }, []);
  const [draft, setDraft] = useState<BindingDraft>(emptyDraft);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ProviderBinding>();
  const patch = (value: Partial<BindingDraft>) => setDraft((current) => ({ ...current, ...value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(draft.configText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Configuration must be a JSON object.');
      config = parsed as Record<string, unknown>;
    } catch (failure) {
      setError(safeMessage(failure, 'Provider configuration is invalid JSON.'));
      return;
    }
    setBusy(true);
    try {
      await apiRequest('/provider-bindings', {
        method: 'POST',
        body: JSON.stringify({
          label: draft.label,
          provider: draft.provider,
          pluginId: draft.pluginId,
          environment: draft.environment,
          credentialId: draft.credentialId,
          config,
        }),
      });
      setDraft(emptyDraft());
      await reload();
    } catch (failure) {
      setError(safeMessage(failure, 'Provider binding could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(
    binding: ProviderBinding,
    label: string,
    environment: string,
    credentialId: string,
    config: Record<string, unknown>,
  ) {
    await apiRequest(`/provider-bindings/${binding.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        label,
        provider: binding.provider,
        pluginId: binding.pluginId,
        environment,
        credentialId,
        config,
      }),
    });
    setEditing(undefined);
    await reload();
  }

  async function remove(binding: ProviderBinding) {
    if (
      !(await confirm(
        'Delete binding',
        `Delete provider binding "${binding.label}"? Agents using it will fail readiness checks.`,
      ))
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await apiRequest(`/provider-bindings/${binding.id}`, { method: 'DELETE' });
      await reload();
    } catch (failure) {
      setError(safeMessage(failure, 'Provider binding could not be deleted.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <SectionCard id="bindings" title="Bindings" padding="flush">
        {bindingsStatus === 'error' ? (
          <div style={{ padding: 'var(--space-5)' }}>
            <ErrorState
              message={bindingsError ?? 'Provider bindings unavailable.'}
              onRetry={reload}
            />
          </div>
        ) : (
          <BindingsTable
            bindings={bindings}
            credentials={credentials}
            plugins={plugins}
            loading={bindingsStatus === 'loading'}
            role={role}
            busy={busy}
            onEdit={setEditing}
            onRemove={remove}
          />
        )}
      </SectionCard>
      <SectionCard
        id="create-binding"
        title="Add binding"
        description="Pairs non-secret provider configuration with a stored credential reference. Agent roles use binding IDs for inference, STT, TTS and telephony."
      >
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <form className="stack" onSubmit={submit}>
          <div className="form-grid">
            <FormField id="binding-label" label="Binding label" required>
              {(props) => (
                <input
                  {...props}
                  value={draft.label}
                  onChange={(event) => patch({ label: event.target.value })}
                />
              )}
            </FormField>
            <FormField
              id="binding-plugin"
              label="Plugin"
              help="Select the installed adapter for this binding."
            >
              {(props) => (
                <Select
                  {...props}
                  value={draft.pluginId}
                  onChange={(value) => {
                    const plugin = plugins.find((item) => item.id === value);
                    const defaults = plugin ? schemaDefaults(plugin) : {};
                    patch({
                      pluginId: plugin?.id ?? '',
                      provider: plugin?.provider ?? '',
                      configText: Object.keys(defaults).length
                        ? JSON.stringify(defaults, null, 2)
                        : draft.configText,
                    });
                  }}
                  placeholder="Select installed plugin"
                  options={plugins.map((plugin) => ({
                    value: plugin.id,
                    label: plugin.ui?.label ?? plugin.id,
                  }))}
                />
              )}
            </FormField>
            <FormField id="binding-environment" label="Environment">
              {(props) => (
                <Select
                  {...props}
                  value={draft.environment}
                  onChange={(value) => patch({ environment: value })}
                  options={[
                    { value: 'test', label: 'Test' },
                    { value: 'staging', label: 'Staging' },
                    { value: 'production', label: 'Production' },
                  ]}
                />
              )}
            </FormField>
            <FormField
              id="binding-credential"
              label="Credential"
              help={!credentials.length ? 'Add a credential first.' : undefined}
            >
              {(props) => (
                <Select
                  {...props}
                  value={draft.credentialId}
                  onChange={(value) => patch({ credentialId: value })}
                  placeholder="Select metadata reference"
                  options={credentials.map((credential) => ({
                    value: credential.id,
                    label: `${credential.label} · ${credential.provider}`,
                  }))}
                />
              )}
            </FormField>
          </div>
          <FormField
            id="binding-config"
            label="Provider configuration JSON"
            help="Add model, voice, region, number, endpoint or adapter options. Secret-like keys are rejected by the API."
          >
            {(props) => (
              <textarea
                {...props}
                className="code-input"
                value={draft.configText}
                onChange={(event) => patch({ configText: event.target.value })}
                spellCheck={false}
              />
            )}
          </FormField>
          <div className="button-row">
            <button className="button primary" disabled={role !== 'admin' || busy}>
              {busy ? 'Saving…' : 'Create binding'}
            </button>
          </div>
        </form>
      </SectionCard>
      <BindingEditDrawer
        binding={editing}
        plugins={plugins}
        credentials={credentials}
        role={role}
        onClose={() => setEditing(undefined)}
        onSubmit={saveEdit}
      />
    </div>
  );
}
