'use client';
import { useEffect, useState } from 'react';
import type { CredentialMetadata, SessionIdentity } from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { SchemaForm } from '../plugins/schema-form';
import { schemaDefaults } from '../plugins/schema-defaults';
import { Drawer } from '../ui/drawer';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';
import { InlineAlert, EmptyStateV2 } from '../ui/feedback-v2';
import { vendorLabel } from './credential-helpers';

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export type NewBindingPayload = {
  label: string;
  provider: string;
  pluginId: string;
  environment: string;
  credentialId: string;
  config: Record<string, unknown>;
};

const EMPTY = { label: '', pluginId: '', environment: 'production', credentialId: '' };

/**
 * Create flow for a provider binding: a drawer with `SchemaForm` for the chosen plugin, matching
 * `BindingEditDrawer` instead of the raw-JSON inline form the Bindings data page used to carry
 * (brief defect #6 — no forms on the data page).
 */
export function BindingCreateDrawer({
  open,
  plugins,
  credentials,
  role,
  onClose,
  onSubmit,
}: {
  open: boolean;
  plugins: PluginOption[];
  credentials: CredentialMetadata[];
  role: SessionIdentity['role'];
  onClose: () => void;
  onSubmit: (payload: NewBindingPayload) => Promise<void>;
}) {
  const [draft, setDraft] = useState(EMPTY);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setDraft(EMPTY);
      setConfig({});
      setError(undefined);
    }
  }, [open]);
  const patch = (value: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...value }));
  const plugin = plugins.find((item) => item.id === draft.pluginId);

  return (
    <Drawer open={open} title="Add binding" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!plugin) return;
          setBusy(true);
          setError(undefined);
          void onSubmit({
            label: draft.label,
            provider: plugin.provider ?? '',
            pluginId: plugin.id,
            environment: draft.environment,
            credentialId: draft.credentialId,
            config,
          })
            .catch((failure) =>
              setError(safeMessage(failure, 'Provider binding could not be saved.')),
            )
            .finally(() => setBusy(false));
        }}
      >
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <p className="muted">
          Pairs non-secret provider configuration with a stored credential reference. Agent roles
          use binding IDs for inference, STT, TTS and telephony.
        </p>
        <div className="form-grid">
          <FormField id="create-binding-label" label="Binding label" required>
            {(props) => (
              <input
                {...props}
                value={draft.label}
                onChange={(event) => patch({ label: event.target.value })}
              />
            )}
          </FormField>
          <FormField
            id="create-binding-plugin"
            label="Plugin"
            help="Select the installed adapter for this binding."
            required
          >
            {(props) => (
              <Select
                {...props}
                value={draft.pluginId}
                onChange={(value) => {
                  const next = plugins.find((item) => item.id === value);
                  setConfig(next ? schemaDefaults(next) : {});
                  patch({ pluginId: value });
                }}
                placeholder="Select installed plugin"
                options={plugins.map((item) => ({
                  value: item.id,
                  label: item.ui?.label ?? item.id,
                }))}
              />
            )}
          </FormField>
          <FormField id="create-binding-environment" label="Environment">
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
            id="create-binding-credential"
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
          <EmptyStateV2 title="Select a plugin">
            Its configuration fields will appear here.
          </EmptyStateV2>
        )}
        <div className="button-row">
          <button
            type="submit"
            className="button primary"
            disabled={role !== 'admin' || busy || !draft.label || !plugin}
          >
            {busy ? 'Saving…' : 'Create binding'}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
