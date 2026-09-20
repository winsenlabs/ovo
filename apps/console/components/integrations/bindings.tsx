'use client';
import { useState, type FormEvent } from 'react';
import {
  apiRequest,
  type CredentialMetadata,
  type ProviderBinding,
  type SessionIdentity,
} from '../../lib/api';
import { Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
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
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setError(undefined);
    try {
      await apiRequest('/provider-bindings', {
        method: 'POST',
        body: JSON.stringify({
          label: values.get('label'),
          provider: values.get('provider'),
          environment: values.get('environment'),
          credentialId: values.get('credentialId'),
          config: {},
        }),
      });
      event.currentTarget.reset();
      await reload();
    } catch (failure) {
      setError(safeMessage(failure, 'Provider binding failed.'));
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
          Bindings reference server-side credentials. They never copy credential values into
          AgentConfig.
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
        <form className="form-grid" onSubmit={submit}>
          <Field label="Binding label" htmlFor="binding-label">
            <input id="binding-label" name="label" required />
          </Field>
          <Field label="Provider" htmlFor="binding-provider">
            <input id="binding-provider" name="provider" required />
          </Field>
          <Field label="Environment" htmlFor="binding-environment">
            <select id="binding-environment" name="environment">
              <option value="test">Test</option>
              <option value="production">Production</option>
            </select>
          </Field>
          <Field label="Credential" htmlFor="binding-credential">
            <select id="binding-credential" name="credentialId" required>
              <option value="">Select metadata reference</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.label}
                </option>
              ))}
            </select>
          </Field>
          <button className="button align-start" disabled={role !== 'admin'}>
            Create binding
          </button>
        </form>
        {bindings.length > 0 && (
          <ul className="plain-list">
            {bindings.map((binding) => (
              <li key={binding.id}>
                <strong>{binding.label}</strong>
                <small>
                  {binding.provider} · {binding.environment} · credential{' '}
                  <span className="mono">{binding.credentialId}</span>
                </small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
