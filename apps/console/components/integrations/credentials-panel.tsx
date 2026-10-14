'use client';
import { useState } from 'react';
import {
  apiRequest,
  ApiError,
  type AgentDraft,
  type CredentialMetadata,
  type ProviderBinding,
  type SessionIdentity,
} from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { SectionCard } from '../ui/section-card';
import { InlineAlert, ErrorState } from '../ui/feedback-v2';
import { useConfirm } from '../ui/dialog';
import { CredentialDrawer } from './credential-drawer';
import { RotateDialog } from './rotate-dialog';
import { CredentialsTable } from './credentials-table';
import { bindingsUsing } from './credential-helpers';

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function CredentialsPanel({
  credentials,
  bindings,
  plugins,
  agents,
  role,
  reload,
}: {
  credentials: {
    status: 'loading' | 'ready' | 'error';
    data: CredentialMetadata[];
    error?: string;
  };
  bindings: ProviderBinding[];
  plugins: PluginOption[];
  agents: AgentDraft[];
  role: SessionIdentity['role'];
  reload: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [rotating, setRotating] = useState<CredentialMetadata>();
  const [message, setMessage] = useState<{ tone: 'neutral' | 'danger'; text: string }>();
  const [busy, setBusy] = useState<string>();

  async function create(payload: {
    label: string;
    pluginId: string;
    type: string;
    environment: string;
    value: string;
    expiresAt?: string;
    permittedAgentIds: string[];
  }) {
    setBusy('create');
    setMessage(undefined);
    try {
      await apiRequest('/credentials', {
        method: 'POST',
        body: JSON.stringify({
          label: payload.label,
          provider: plugins.find((plugin) => plugin.id === payload.pluginId)?.provider,
          type: payload.type,
          environment: payload.environment,
          value: payload.value,
          expiresAt: payload.expiresAt ? new Date(payload.expiresAt).toISOString() : undefined,
          permittedAgentIds: payload.permittedAgentIds,
        }),
      });
      setMessage({
        tone: 'neutral',
        text: `${payload.label} saved. Only redacted metadata was returned.`,
      });
      setCreateOpen(false);
      await reload();
    } catch (error) {
      setMessage({ tone: 'danger', text: safeMessage(error, 'Credential creation failed.') });
    } finally {
      setBusy(undefined);
    }
  }

  async function rotate(credential: CredentialMetadata, value: string) {
    setBusy(`rotate-${credential.id}`);
    setMessage(undefined);
    try {
      await apiRequest(`/credentials/${credential.id}/rotate`, {
        method: 'POST',
        body: JSON.stringify({ value }),
      });
      setMessage({ tone: 'neutral', text: `${credential.label} rotated.` });
      setRotating(undefined);
      await reload();
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: safeMessage(error, 'Rotation failed; the prior value remains in effect.'),
      });
    } finally {
      setBusy(undefined);
    }
  }

  async function retire(credential: CredentialMetadata) {
    const dependents = bindingsUsing(credential.id, bindings);
    const warning = dependents.length
      ? ` ${dependents.length} binding${dependents.length === 1 ? '' : 's'} (${dependents
          .map((binding) => binding.label)
          .join(', ')}) reference it; the API will block this while they remain.`
      : '';
    if (!(await confirm('Retire credential', `Retire ${credential.label}?${warning}`))) return;
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
    <SectionCard
      id="credentials"
      title="Credentials"
      description="Values are write-only: there is no reveal action, and a value is never returned once saved."
      padding="flush"
      actions={
        <button
          type="button"
          className="button primary"
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin role required' : undefined}
          onClick={() => setCreateOpen(true)}
        >
          Add credential
        </button>
      }
    >
      {message && (
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <InlineAlert tone={message.tone === 'danger' ? 'danger' : 'info'}>
            {message.text}
          </InlineAlert>
        </div>
      )}
      {credentials.status === 'error' ? (
        <div style={{ padding: 'var(--space-5)' }}>
          <ErrorState message={credentials.error ?? 'Credentials unavailable.'} onRetry={reload} />
        </div>
      ) : (
        <CredentialsTable
          credentials={credentials.data}
          bindings={bindings}
          plugins={plugins}
          role={role}
          busy={busy}
          loading={credentials.status === 'loading'}
          onRotate={setRotating}
          onRetire={retire}
          onAdd={() => setCreateOpen(true)}
        />
      )}
      <CredentialDrawer
        open={createOpen}
        plugins={plugins}
        agents={agents}
        busy={busy === 'create'}
        onClose={() => setCreateOpen(false)}
        onSubmit={create}
      />
      <RotateDialog
        credential={rotating}
        busy={Boolean(rotating) && busy === `rotate-${rotating?.id}`}
        onClose={() => setRotating(undefined)}
        onSubmit={rotate}
      />
    </SectionCard>
  );
}
