'use client';
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
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

interface BindingDraft {
  id?: string;
  label: string;
  provider: string;
  environment: string;
  credentialId: string;
  configText: string;
}
const emptyDraft = (): BindingDraft => ({
  label: '',
  provider: '',
  environment: 'production',
  credentialId: '',
  configText: '{\n  "model": ""\n}',
});
const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

function bindingDraft(binding: ProviderBinding): BindingDraft {
  return { ...binding, configText: JSON.stringify(binding.config ?? {}, null, 2) };
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
      !window.confirm(
        `Delete provider binding “${binding.label}”? Agents using it will fail readiness checks.`,
      )
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
          <Notice tone="danger" live>
            {error}
          </Notice>
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
              label="Provider"
              htmlFor="binding-provider"
              help="Provider adapter ID, for example openai, elevenlabs or twilio."
            >
              <input
                id="binding-provider"
                required
                value={draft.provider}
                onChange={(event) => patch({ provider: event.target.value })}
              />
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
        {!bindings.length ? (
          <EmptyState title="No provider bindings">
            Create a binding before assigning provider roles to an agent.
          </EmptyState>
        ) : (
          <ResponsiveTable label="Provider bindings">
            <thead>
              <tr>
                <th>Binding</th>
                <th>Provider</th>
                <th>Environment</th>
                <th>Credential</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((binding) => (
                <tr key={binding.id}>
                  <td>
                    <strong>{binding.label}</strong>
                    <small className="mono">{binding.id}</small>
                  </td>
                  <td>
                    {binding.provider}
                    <JsonEvidence label="Configuration" value={binding.config ?? {}} />
                  </td>
                  <td>{binding.environment}</td>
                  <td className="mono">{binding.credentialId}</td>
                  <td>
                    <div className="button-row">
                      <button
                        className="button small"
                        type="button"
                        disabled={role !== 'admin' || busy}
                        onClick={() => setDraft(bindingDraft(binding))}
                      >
                        Edit
                      </button>
                      <button
                        className="button small danger"
                        type="button"
                        disabled={role !== 'admin' || busy}
                        onClick={() => void remove(binding)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </div>
    </Panel>
  );
}
