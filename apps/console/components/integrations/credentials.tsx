'use client';
import { useState, type FormEvent } from 'react';
import {
  apiRequest,
  ApiError,
  type AgentDraft,
  type CredentialMetadata,
  type ProviderBinding,
  type SessionIdentity,
} from '../../lib/api';
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
export function CredentialManager({
  credentials,
  agents,
  reload,
  role,
}: {
  credentials: CredentialMetadata[];
  agents: AgentDraft[];
  reload: () => Promise<void>;
  role: SessionIdentity['role'];
}) {
  const [message, setMessage] = useState<{ tone: 'neutral' | 'danger'; text: string }>();
  const [busy, setBusy] = useState<string>();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const valueInput = form.elements.namedItem('value') as HTMLInputElement;
    setBusy('create');
    setMessage(undefined);
    try {
      await apiRequest('/credentials', {
        method: 'POST',
        body: JSON.stringify({
          label: values.get('label'),
          provider: values.get('provider'),
          type: values.get('type'),
          environment: values.get('environment'),
          value: values.get('value'),
          expiresAt: values.get('expiresAt')
            ? new Date(String(values.get('expiresAt'))).toISOString()
            : undefined,
          permittedAgentIds: values.getAll('permittedAgentIds'),
        }),
      });
      valueInput.value = '';
      form.reset();
      setMessage({
        tone: 'neutral',
        text: 'Credential saved. Only redacted metadata was returned.',
      });
      await reload();
    } catch (error) {
      setMessage({ tone: 'danger', text: safeMessage(error, 'Credential creation failed.') });
    } finally {
      setBusy(undefined);
    }
  }

  async function rotate(credential: CredentialMetadata) {
    const input = document.getElementById(`rotate-${credential.id}`) as HTMLInputElement | null;
    const value = input?.value ?? '';
    if (input) input.value = '';
    if (!value) {
      setMessage({ tone: 'danger', text: `Enter a new value for ${credential.label}.` });
      return;
    }
    setBusy(`rotate-${credential.id}`);
    setMessage(undefined);
    try {
      await apiRequest(`/credentials/${credential.id}/rotate`, {
        method: 'POST',
        body: JSON.stringify({ value }),
      });
      setMessage({
        tone: 'neutral',
        text: `${credential.label} rotated. New calls use the new binding according to backend policy.`,
      });
      await reload();
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: safeMessage(
          error,
          'Rotation failed; the prior binding remains unchanged unless the API reports otherwise.',
        ),
      });
    } finally {
      setBusy(undefined);
    }
  }

  async function retire(credential: CredentialMetadata) {
    if (
      !confirm(
        `Retire ${credential.label}? The API will block this while active references remain.`,
      )
    )
      return;
    setBusy(`retire-${credential.id}`);
    setMessage(undefined);
    try {
      await apiRequest(`/credentials/${credential.id}/retire`, { method: 'POST' });
      setMessage({ tone: 'neutral', text: `${credential.label} retired.` });
      await reload();
    } catch (error) {
      const suffix =
        error instanceof ApiError && error.details
          ? ` References: ${JSON.stringify(error.details)}`
          : '';
      setMessage({ tone: 'danger', text: `${safeMessage(error, 'Retirement failed.')}${suffix}` });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="stack">
      <Panel labelledBy="credential-create-title">
        <PanelHeader
          id="credential-create-title"
          title="Add write-only credential"
          badge={
            <StatusBadge tone={role === 'admin' ? 'soft' : 'warning'}>
              {role === 'admin' ? 'Admin action' : 'Admin required'}
            </StatusBadge>
          }
        />
        <form className="panel-body stack" onSubmit={create} autoComplete="off">
          <div className="key-callout">
            <strong>Write only</strong>
            <span>
              No reveal action exists. The value is cleared after a successful save and must never
              appear in API metadata.
            </span>
          </div>
          <div className="form-grid">
            <Field label="Label" htmlFor="credential-label">
              <input id="credential-label" name="label" required />
            </Field>
            <Field label="Provider" htmlFor="credential-provider">
              <input
                id="credential-provider"
                name="provider"
                placeholder="e.g. deepgram"
                required
              />
            </Field>
            <Field label="Credential type" htmlFor="credential-type">
              <select id="credential-type" name="type">
                <option value="stt">STT</option>
                <option value="tts">TTS</option>
                <option value="llm">LLM</option>
                <option value="carrier">Carrier</option>
                <option value="tool">Tool API</option>
              </select>
            </Field>
            <Field label="Environment" htmlFor="credential-environment">
              <select id="credential-environment" name="environment">
                <option value="test">Test</option>
                <option value="production">Production</option>
              </select>
            </Field>
          </div>
          <Field
            label="Credential value"
            htmlFor="credential-value"
            help="Sent once to the management API over this same-origin gateway."
          >
            <input
              id="credential-value"
              name="value"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              required
            />
          </Field>
          <div className="form-grid">
            <Field label="Expiry (optional)" htmlFor="credential-expiry">
              <input id="credential-expiry" name="expiresAt" type="datetime-local" />
            </Field>
            <Field label="Permitted agent" htmlFor="credential-agent">
              <select id="credential-agent" name="permittedAgentIds" multiple>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.config.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button
            className="button primary align-start"
            disabled={role !== 'admin' || busy === 'create'}
          >
            {busy === 'create' ? 'Saving…' : 'Save credential'}
          </button>
        </form>
      </Panel>
      {message && (
        <Notice tone={message.tone} live>
          {message.text}
        </Notice>
      )}
      <Panel labelledBy="credentials-title">
        <PanelHeader
          id="credentials-title"
          title="Credential metadata"
          badge={<StatusBadge>{credentials.length}</StatusBadge>}
        />
        {credentials.length === 0 ? (
          <div className="panel-body">
            <EmptyState title="No credential metadata">
              The API returned an empty collection. No placeholder keys are displayed.
            </EmptyState>
          </div>
        ) : (
          <ResponsiveTable label="Credential metadata and lifecycle actions">
            <thead>
              <tr>
                <th>Credential</th>
                <th>Scope</th>
                <th>Safe metadata</th>
                <th>Rotate</th>
                <th>Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.id}>
                  <td>
                    <strong>{credential.label}</strong>
                    <small>
                      {credential.provider} · {credential.type}
                    </small>
                  </td>
                  <td>
                    {credential.environment}
                    <small>
                      {credential.permittedAgentIds?.length
                        ? `${credential.permittedAgentIds.length} permitted agents`
                        : 'No agent restriction returned'}
                    </small>
                  </td>
                  <td>
                    <span className="mono">
                      {credential.fingerprint ?? 'Fingerprint unavailable'}
                    </span>
                    <small>
                      {credential.status ?? 'Validation not reported'} ·{' '}
                      {credential.rotatedAt
                        ? `rotated ${new Date(credential.rotatedAt).toLocaleString()}`
                        : 'never rotated'}
                    </small>
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={`rotate-${credential.id}`}>
                      New value for {credential.label}
                    </label>
                    <input
                      className="compact-secret"
                      id={`rotate-${credential.id}`}
                      type="password"
                      autoComplete="new-password"
                      placeholder="New value"
                    />
                    <button
                      className="button small"
                      disabled={role !== 'admin' || Boolean(busy)}
                      onClick={() => rotate(credential)}
                    >
                      Rotate
                    </button>
                  </td>
                  <td>
                    <button
                      className="button small danger"
                      disabled={role !== 'admin' || Boolean(busy)}
                      onClick={() => retire(credential)}
                    >
                      Retire
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </Panel>
    </div>
  );
}
