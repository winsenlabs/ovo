'use client';
import { useConfirm } from '../ui/dialog';
import { useEffect, useState, type FormEvent } from 'react';
import {
  apiRequest,
  type CredentialMetadata,
  type ProviderBinding,
  type SessionIdentity,
} from '../../lib/api';
import {
  EmptyState,
  Field,
  JsonEvidence,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import type { PluginCatalog } from '../plugins/types';
import { BindingsTable } from './bindings-table';

interface BindingDraft {
  id?: string;
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

function bindingDraft(binding: ProviderBinding): BindingDraft {
  return {
    ...binding,
    pluginId: binding.pluginId ?? '',
    configText: JSON.stringify(binding.config ?? {}, null, 2),
  };
}

export function BindingManager({
  bindings,
  credentials,
  reload,
  role,
}: {
  bindings: ProviderBinding[];
  credentials: CredentialMetadata[];
  reload: () => Promise<void>;
  role: SessionIdentity['role'];
}) {
  const confirm = useConfirm();
  const [plugins, setPlugins] = useState<PluginCatalog['plugins']>([]);
  useEffect(() => {
    void apiRequest<PluginCatalog>('/plugins')
      .then(({ data }) =>
        setPlugins(
          data.plugins.filter((plugin) => ['carrier', 'stt', 'tts', 'llm'].includes(plugin.kind)),
        ),
      )
      .catch(() => undefined);
  }, []);
  const [draft, setDraft] = useState<BindingDraft>(emptyDraft);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (draft.id && !bindings.some((binding) => binding.id === draft.id)) setDraft(emptyDraft());
  }, [bindings, draft.id]);
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
      await apiRequest(`/provider-bindings${draft.id ? `/${draft.id}` : ''}`, {
        method: draft.id ? 'PUT' : 'POST',
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

  async function remove(binding: ProviderBinding) {
    if (
      !(await confirm(
        'Delete binding',
        `Delete provider binding “${binding.label}”? Agents using it will fail readiness checks.`,
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
    <Panel labelledBy="binding-title">
      <PanelHeader
        id="binding-title"
        title="Provider bindings"
        badge={<StatusBadge>{bindings.length}</StatusBadge>}
      />
      <div className="panel-body stack">
        <p className="muted">
          Bindings pair non-secret provider configuration with a server-side credential reference.
          Agent roles use binding IDs for inference, STT, TTS and telephony.
        </p>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <form className="stack nested-card" onSubmit={submit}>
          <div className="tool-meta">
            <h3>{draft.id ? 'Edit binding' : 'Create binding'}</h3>
            {draft.id && <StatusBadge tone="soft">Editing</StatusBadge>}
          </div>
          <div className="form-grid">
            <Field label="Binding label" htmlFor="binding-label">
              <input
                id="binding-label"
                required
                value={draft.label}
                onChange={(event) => patch({ label: event.target.value })}
              />
            </Field>
            <Field
              label="Plugin"
              htmlFor="binding-plugin"
              help="Select the installed adapter for this binding."
            >
              <select
                id="binding-plugin"
                required
                value={draft.pluginId}
                onChange={(event) => {
                  const plugin = plugins.find((item) => item.id === event.target.value);
                  patch({ pluginId: plugin?.id ?? '', provider: plugin?.provider ?? '' });
                }}
              >
                <option value="">Select installed plugin</option>
                {plugins.map((plugin) => (
                  <option key={plugin.id} value={plugin.id}>
                    {plugin.ui?.label ?? plugin.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Environment" htmlFor="binding-environment">
              <select
                id="binding-environment"
                value={draft.environment}
                onChange={(event) => patch({ environment: event.target.value })}
              >
                <option value="test">Test</option>
                <option value="staging">Staging</option>
                <option value="production">Production</option>
              </select>
            </Field>
            <Field label="Credential" htmlFor="binding-credential">
              <select
                id="binding-credential"
                required
                value={draft.credentialId}
                onChange={(event) => patch({ credentialId: event.target.value })}
              >
                <option value="">Select metadata reference</option>
                {credentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.label} · {credential.provider}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="Provider configuration JSON"
            htmlFor="binding-config"
            help="Add model, voice, region, number, endpoint or adapter options. Secret-like keys are rejected by the API."
          >
            <textarea
              id="binding-config"
              className="code-input"
              value={draft.configText}
              onChange={(event) => patch({ configText: event.target.value })}
              spellCheck={false}
            />
          </Field>
          <div className="button-row">
            <button className="button primary" disabled={role !== 'admin' || busy}>
              {busy ? 'Saving…' : draft.id ? 'Update binding' : 'Create binding'}
            </button>
            {draft.id && (
              <button className="button" type="button" onClick={() => setDraft(emptyDraft())}>
                Cancel
              </button>
            )}
          </div>
        </form>
        <BindingsTable
          bindings={bindings}
          role={role}
          busy={busy}
          onEdit={(binding) => setDraft(bindingDraft(binding))}
          onRemove={remove}
        />
      </div>
    </Panel>
  );
}
