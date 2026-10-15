'use client';
import { useEffect, useState } from 'react';
import type { CredentialMetadata, ProviderBinding, SessionIdentity } from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { SchemaForm } from '../plugins/schema-form';
import { Drawer } from '../ui/drawer';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';
import { InlineAlert } from '../ui/feedback-v2';
import { vendorLabel } from './credential-helpers';

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * Edit flow for an existing binding: `SchemaForm` renders the plugin's `bindingSchema` (falling
 * back to `configSchema`, then to its own "Advanced JSON" editor when neither applies) instead of
 * the single raw textarea the create form still uses.
 */
export function BindingEditDrawer({
  binding,
  plugins,
  credentials,
  role,
  onClose,
  onSubmit,
}: {
  binding: ProviderBinding | undefined;
  plugins: PluginOption[];
  credentials: CredentialMetadata[];
  role: SessionIdentity['role'];
  onClose: () => void;
  onSubmit: (
    binding: ProviderBinding,
    label: string,
    environment: string,
    credentialId: string,
    config: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [credentialId, setCredentialId] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  // The fallback "Advanced JSON" textarea below is rendered as a controlled input off this text,
  // kept in sync with `config` by the effect below — `defaultValue` would freeze on the `{}` the
  // state held at the first render, before the effect had a chance to populate it from `binding`.
  const [configText, setConfigText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!binding) return;
    setLabel(binding.label);
    setEnvironment(binding.environment);
    setCredentialId(binding.credentialId);
    setConfig(binding.config ?? {});
    setConfigText(JSON.stringify(binding.config ?? {}, null, 2));
    setError(undefined);
  }, [binding]);
  if (!binding) return null;
  const plugin = plugins.find((item) => item.id === binding.pluginId);

  return (
    <Drawer open title={`Edit ${binding.label}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          void onSubmit(binding, label, environment, credentialId, config)
            .catch((failure) =>
              setError(safeMessage(failure, 'Provider binding could not be saved.')),
            )
            .finally(() => setBusy(false));
        }}
      >
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <div className="form-grid">
          <FormField id="edit-binding-label" label="Binding label" required>
            {(props) => (
              <input {...props} value={label} onChange={(event) => setLabel(event.target.value)} />
            )}
          </FormField>
          <FormField id="edit-binding-environment" label="Environment">
            {(props) => (
              <Select
                {...props}
                value={environment}
                onChange={setEnvironment}
                options={[
                  { value: 'test', label: 'Test' },
                  { value: 'staging', label: 'Staging' },
                  { value: 'production', label: 'Production' },
                ]}
              />
            )}
          </FormField>
          <FormField id="edit-binding-credential" label="Credential">
            {(props) => (
              <Select
                {...props}
                value={credentialId}
                onChange={setCredentialId}
                placeholder="Select metadata reference"
                options={credentials.map((credential) => ({
                  value: credential.id,
                  label: `${credential.label} · ${vendorLabel(credential.provider, plugins)}`,
                }))}
              />
            )}
          </FormField>
        </div>
        {plugin ? (
          <SchemaForm
            plugin={plugin}
            value={config}
            onChange={setConfig}
            credentials={credentials}
          />
        ) : (
          <FormField
            id="edit-binding-config"
            label="Provider configuration JSON"
            help="This binding's plugin is no longer installed, so its configuration is shown as raw JSON."
          >
            {(props) => (
              <textarea
                {...props}
                className="code-input"
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                onBlur={(event) => {
                  try {
                    setConfig(JSON.parse(event.target.value) as Record<string, unknown>);
                    setError(undefined);
                  } catch {
                    setError('Enter a valid JSON object.');
                  }
                }}
              />
            )}
          </FormField>
        )}
        <div className="button-row">
          <button
            type="submit"
            className="button primary"
            disabled={role !== 'admin' || busy || !label}
          >
            {busy ? 'Saving…' : 'Save binding'}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
