'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest, type CredentialMetadata, type ProviderBinding } from '../../lib/api';
import { Drawer } from '../ui/drawer';
import { FormField } from '../ui/form-field';
import { SchemaForm } from './schema-form';
import { CarrierOperatorUrls } from './carrier-operator-urls';
import type { PluginOption } from './types';
export { carrierOperatorUrls } from './carrier-operator-urls';
export function BindingSelect({
  plugin,
  bindings,
  credentials,
  value,
  onChange,
  onCreated,
  onCredentialCreated,
}: {
  plugin: PluginOption;
  bindings: readonly ProviderBinding[];
  credentials: readonly CredentialMetadata[];
  value?: string;
  onChange: (id?: string) => void;
  onCreated?: (binding: ProviderBinding) => void;
  onCredentialCreated?: (credential: CredentialMetadata) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [createdCredential, setCreatedCredential] = useState<CredentialMetadata>();
  const [credentialBusy, setCredentialBusy] = useState(false);
  const credentialValue = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string>();
  const filtered = bindings.filter((binding) => binding.pluginId === plugin.id);
  const credentialOptions = [
    ...credentials.filter((item) => item.id !== createdCredential?.id),
    ...(createdCredential ? [createdCredential] : []),
  ].filter((item) => item.provider === plugin.provider);
  const invalidBindingSecret = Object.keys(plugin.bindingSchema?.properties ?? {}).some(
    (key) =>
      plugin.secretFields?.includes(`/${key}`) || plugin.ui?.fields?.[key]?.widget === 'secret',
  );
  useEffect(() => {
    setCredentialId('');
    setCreatedCredential(undefined);
    setConfig({});
    setError(undefined);
    if (credentialValue.current) credentialValue.current.value = '';
  }, [plugin.id]);
  async function saveCredential() {
    const input = credentialValue.current;
    if (!input?.value || !plugin.provider) {
      setError('Enter a credential value for this plugin.');
      return;
    }
    setCredentialBusy(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<CredentialMetadata>('/credentials', {
        method: 'POST',
        body: JSON.stringify({
          label: `${label.trim() || plugin.ui?.label || plugin.provider} credential`,
          provider: plugin.provider,
          type: plugin.kind,
          environment: 'production',
          value: input.value,
          permittedAgentIds: [],
        }),
      });
      if (!data.id) throw new Error('Credential response omitted its id.');
      input.value = '';
      setCreatedCredential(data);
      setCredentialId(data.id);
      onCredentialCreated?.(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Credential creation failed');
    } finally {
      setCredentialBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (invalidBindingSecret) {
      setError('This plugin declares a secret field in its non-secret binding schema.');
      return;
    }
    if (!credentialId) {
      setError('Select or save a credential before creating the binding.');
      return;
    }
    try {
      const { data } = await apiRequest<ProviderBinding>('/provider-bindings', {
        method: 'POST',
        body: JSON.stringify({
          label,
          provider: plugin.provider,
          pluginId: plugin.id,
          environment: 'production',
          credentialId,
          config,
        }),
      });
      onCreated?.(data);
      onChange(data.id);
      setOpen(false);
      setConfig({});
      setLabel('');
      setCredentialId('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Binding creation failed');
    }
  }
  return (
    <div className="ui-stack">
      <div className="ui-cluster">
        <FormField id={`binding-${plugin.kind}`} label="Binding">
          {(props) => (
            <select
              {...props}
              value={value ?? ''}
              onChange={(event) => onChange(event.target.value || undefined)}
            >
              <option value="">Environment binding</option>
              {filtered.map((binding) => (
                <option key={binding.id} value={binding.id}>
                  {binding.label}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <button className="button" type="button" onClick={() => setOpen(true)}>
          Create binding
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {plugin.kind === 'carrier' && value && <CarrierOperatorUrls bindingId={value} />}
      <Drawer
        open={open}
        title={`Create ${plugin.ui?.label ?? plugin.provider} binding`}
        onClose={() => setOpen(false)}
      >
        <form className="ui-stack" onSubmit={create}>
          <FormField id="new-binding-label" label="Label" required>
            {(props) => (
              <input {...props} value={label} onChange={(event) => setLabel(event.target.value)} />
            )}
          </FormField>
          <FormField id="new-binding-credential" label="Credential" required>
            {(props) => (
              <select
                {...props}
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
              >
                <option value="">Select credential</option>
                {credentialOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="new-credential-value"
            label="New credential value"
            help="Sent once through the management API; the binding stores only its credential ID."
          >
            {(props) => (
              <input
                {...props}
                ref={credentialValue}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
              />
            )}
          </FormField>
          <button
            className="button"
            type="button"
            disabled={credentialBusy}
            onClick={() => void saveCredential()}
          >
            {credentialBusy ? 'Saving credential…' : 'Save credential'}
          </button>
          {createdCredential && credentialId === createdCredential.id && (
            <p>Stored · fingerprint {createdCredential.fingerprint ?? 'unavailable'}</p>
          )}
          {invalidBindingSecret && (
            <p role="alert">
              This plugin declares a secret field in its non-secret binding schema.
            </p>
          )}
          <SchemaForm
            plugin={plugin}
            schema={plugin.bindingSchema ?? {}}
            value={config}
            onChange={setConfig}
          />
          <button
            className="button primary"
            type="submit"
            disabled={credentialBusy || invalidBindingSecret}
          >
            Create binding
          </button>
        </form>
      </Drawer>
    </div>
  );
}
