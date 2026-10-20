'use client';
import { useState } from 'react';
import { isReservedHeader } from '../../lib/derive/queues';
import type { WebhookSpec } from '../../lib/types/queues';
import { FormSection, SelectField, TextField } from '../../components/routing/fields';

export interface CredentialOption {
  value: string;
  label: string;
}

function HeadersEditor({
  headers,
  onChange,
}: {
  headers: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const reserved = name !== '' && isReservedHeader(name);
  const valid = /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) && !reserved && !(name in headers);
  return (
    <fieldset className="queue-lines">
      <legend>Extra headers</legend>
      {Object.entries(headers).map(([key, current]) => (
        <div key={key} className="queue-lines-row">
          <label>
            <span className="ds-chip">{key}</span>
            <input
              aria-label={`Header ${key}`}
              value={current}
              maxLength={256}
              onChange={(event) => onChange({ ...headers, [key]: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="text-button"
            aria-label={`Remove header ${key}`}
            onClick={() =>
              onChange(Object.fromEntries(Object.entries(headers).filter(([k]) => k !== key)))
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div className="queue-lines-row">
        <input
          aria-label="New header name"
          placeholder="Header name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="New header value"
          placeholder="Value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="button"
          disabled={!valid}
          onClick={() => {
            onChange({ ...headers, [name]: value });
            setName('');
            setValue('');
          }}
        >
          Add header
        </button>
      </div>
      {reserved && (
        <small className="field-error">That header is set by OVO and cannot be overridden.</small>
      )}
    </fieldset>
  );
}

/** Where the handoff is posted, how it is signed and authenticated. */
export function WebhookFields({
  spec,
  credentials,
  errors,
  onChange,
}: {
  spec: WebhookSpec;
  credentials: readonly CredentialOption[];
  errors: Record<string, string | undefined>;
  onChange: (spec: WebhookSpec) => void;
}) {
  const set = <K extends keyof WebhookSpec>(key: K, value: WebhookSpec[K]) =>
    onChange({ ...spec, [key]: value });
  return (
    <FormSection
      title="Webhook"
      description="When a caller needs a person, OVO posts the call details here, signed with the secret below, and waits for an answer."
    >
      <TextField
        id="queue-url"
        label="Endpoint URL"
        type="url"
        mono
        required
        value={spec.url}
        placeholder="https://acd.example.com/ovo/handoff"
        help="Must be public HTTPS. Redirects are not followed."
        error={errors['webhook.url']}
        onChange={(value) => set('url', value)}
      />
      <div className="form-grid">
        <SelectField
          id="queue-method"
          label="Method"
          value={spec.method}
          options={[
            { value: 'POST', label: 'POST' },
            { value: 'PUT', label: 'PUT' },
          ]}
          onChange={(value) => set('method', value as WebhookSpec['method'])}
        />
        <SelectField
          id="queue-format"
          label="Body format"
          value={spec.format}
          options={[
            { value: 'json', label: 'JSON' },
            { value: 'form', label: 'Form (flat fields only)' },
          ]}
          onChange={(value) => set('format', value as WebhookSpec['format'])}
        />
      </div>
      <SelectField
        id="queue-credential"
        label="Signing secret"
        value={spec.credentialId}
        placeholder="Choose a credential…"
        options={credentials}
        help="Signs every request and verifies the third party's callbacks."
        error={errors['webhook.credentialId']}
        onChange={(value) => set('credentialId', value)}
      />
      <SelectField
        id="queue-auth"
        label="Extra authentication"
        value={spec.auth.kind}
        options={[
          { value: 'none', label: 'None' },
          { value: 'bearer', label: 'Bearer token' },
          { value: 'header', label: 'API key header' },
        ]}
        onChange={(kind) =>
          set(
            'auth',
            kind === 'none'
              ? { kind: 'none' }
              : kind === 'bearer'
                ? { kind: 'bearer', credentialId: '' }
                : { kind: 'header', name: 'X-Api-Key', credentialId: '' },
          )
        }
      />
      {spec.auth.kind !== 'none' && (
        <SelectField
          id="queue-auth-credential"
          label="Authentication credential"
          value={spec.auth.credentialId}
          placeholder="Choose a credential…"
          options={credentials}
          error={errors['webhook.auth.credentialId']}
          onChange={(credentialId) =>
            set('auth', { ...spec.auth, credentialId } as WebhookSpec['auth'])
          }
        />
      )}
      {spec.auth.kind === 'header' && (
        <TextField
          id="queue-auth-header"
          label="Header name"
          value={spec.auth.name}
          error={errors['webhook.auth.name']}
          onChange={(name) => set('auth', { ...spec.auth, name } as WebhookSpec['auth'])}
        />
      )}
      <HeadersEditor headers={spec.headers} onChange={(headers) => set('headers', headers)} />
    </FormSection>
  );
}
