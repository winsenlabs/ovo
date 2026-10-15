'use client';
import { useEffect, useState } from 'react';
import { useConfirm } from '../ui/dialog';
import {
  apiRequest,
  type CredentialMetadata,
  type ProviderBinding,
  type SessionIdentity,
} from '../../lib/api';
import { SectionCard } from '../ui/section-card';
import { ErrorState, InlineAlert } from '../ui/feedback-v2';
import type { PluginCatalog, PluginOption } from '../plugins/types';
import { BindingsTable } from './bindings-table';
import { BindingEditDrawer } from './binding-edit-drawer';
import { BindingCreateDrawer, type NewBindingPayload } from './binding-create-drawer';

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * The Bindings tab of Providers & secrets. "Add binding" opens a drawer (`BindingCreateDrawer`)
 * reusing `SchemaForm`, rather than the data page carrying its own inline form (brief defect #6 —
 * no forms on the data page). `BindingManager` is intentionally kept self-contained (it loads its
 * own `/plugins`) so it works the same standalone, which
 * `components/plugins/binding-defaults.test.tsx` (owned by the agents/plugins lane) exercises by
 * mounting it directly.
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
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ProviderBinding>();
  const [createOpen, setCreateOpen] = useState(false);

  async function create(payload: NewBindingPayload) {
    await apiRequest('/provider-bindings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setCreateOpen(false);
    await reload();
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
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <SectionCard
        id="bindings"
        title="Bindings"
        padding="flush"
        actions={
          <button
            type="button"
            className="button primary"
            disabled={role !== 'admin'}
            title={role !== 'admin' ? 'Admin role required' : undefined}
            onClick={() => setCreateOpen(true)}
          >
            Add binding
          </button>
        }
      >
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
      <BindingEditDrawer
        binding={editing}
        plugins={plugins}
        credentials={credentials}
        role={role}
        onClose={() => setEditing(undefined)}
        onSubmit={saveEdit}
      />
      <BindingCreateDrawer
        open={createOpen}
        plugins={plugins}
        credentials={credentials}
        role={role}
        onClose={() => setCreateOpen(false)}
        onSubmit={create}
      />
    </div>
  );
}
