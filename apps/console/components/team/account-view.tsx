'use client';

import { useRef, useState, type FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import {
  changePasswordPayload,
  USER_PASSWORD_MAX_LENGTH,
  USER_PASSWORD_MIN_LENGTH,
} from '../../lib/user-contract';
import { PageHeader } from '../ui/layout';
import { SectionCard, KeyValueGrid } from '../ui/section-card';
import { FormField } from '../ui/form-field';
import { InlineAlert } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { ThemeToggle } from '../ui/theme-toggle';

export function AccountView({
  identity,
  onSessionRevoked,
}: {
  identity: SessionIdentity;
  onSessionRevoked(reason: string): void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const currentPassword = String(values.get('currentPassword') ?? '');
    const newPassword = String(values.get('newPassword') ?? '');
    const confirmation = String(values.get('confirmation') ?? '');
    form.current?.reset();
    if (newPassword !== confirmation) {
      setError('The new password and confirmation do not match.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await apiRequest('/auth/password', {
        method: 'PATCH',
        body: JSON.stringify(changePasswordPayload(currentPassword, newPassword)),
      });
      onSessionRevoked('Your password changed. Sign in again with the new password.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The password could not be changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Settings"
        title="Account"
        description="Your profile and sign-in on this organization."
      />

      <SectionCard title="Profile">
        <KeyValueGrid
          columns={2}
          items={[
            { label: 'Name', value: identity.label ?? identity.name ?? null },
            { label: 'Email', value: identity.email ?? null, mono: Boolean(identity.email) },
            {
              label: 'Role',
              value: (
                <StatusBadgeV2
                  value={identity.role}
                  tone={identity.role === 'admin' ? 'ok' : 'info'}
                />
              ),
            },
            {
              label: 'Workspace',
              value: identity.workspace?.name ?? identity.workspaceId ?? null,
            },
          ]}
        />
      </SectionCard>

      <SectionCard
        title="Change password"
        description="Changing your password ends this session on success — you sign in again with the new one."
      >
        <form ref={form} className="stack" onSubmit={changePassword}>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
          <FormField label="Current password" id="account-current-password">
            {(control) => (
              <input
                {...control}
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                minLength={USER_PASSWORD_MIN_LENGTH}
                maxLength={USER_PASSWORD_MAX_LENGTH}
                required
              />
            )}
          </FormField>
          <div className="form-grid">
            <FormField
              label="New password"
              id="account-new-password"
              help={`${USER_PASSWORD_MIN_LENGTH}–${USER_PASSWORD_MAX_LENGTH} characters.`}
            >
              {(control) => (
                <input
                  {...control}
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={USER_PASSWORD_MIN_LENGTH}
                  maxLength={USER_PASSWORD_MAX_LENGTH}
                  required
                />
              )}
            </FormField>
            <FormField label="Confirm new password" id="account-confirm-password">
              {(control) => (
                <input
                  {...control}
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  minLength={USER_PASSWORD_MIN_LENGTH}
                  maxLength={USER_PASSWORD_MAX_LENGTH}
                  required
                />
              )}
            </FormField>
          </div>
          <button className="button primary align-start" disabled={busy}>
            {busy ? 'Changing password…' : 'Change password'}
          </button>
        </form>
      </SectionCard>

      <SectionCard title="Appearance" description="Applies only to this browser.">
        <ThemeToggle />
      </SectionCard>
    </div>
  );
}
