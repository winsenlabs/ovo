'use client';

import { useRef, useState, type FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import {
  changePasswordPayload,
  USER_PASSWORD_MAX_LENGTH,
  USER_PASSWORD_MIN_LENGTH,
} from '../../lib/user-contract';
import { Field, Panel, PanelHeader } from '../primitives';

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
      <header className="page-heading">
        <div>
          <p className="eyebrow">Account</p>
          <h1>Your password</h1>
          <p className="muted">
            Change the password for {identity.label ?? identity.email ?? 'your user account'}.
          </p>
        </div>
      </header>
      <Panel labelledBy="account-password-title">
        <PanelHeader id="account-password-title" title="Change password">
          <p className="muted">Changing your password ends this session on success.</p>
        </PanelHeader>
        <form ref={form} className="panel-body stack" onSubmit={changePassword}>
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
          <Field label="Current password" htmlFor="account-current-password">
            <input
              id="account-current-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              minLength={USER_PASSWORD_MIN_LENGTH}
              maxLength={USER_PASSWORD_MAX_LENGTH}
              required
            />
          </Field>
          <div className="form-grid">
            <Field
              label="New password"
              htmlFor="account-new-password"
              help={`${USER_PASSWORD_MIN_LENGTH}–${USER_PASSWORD_MAX_LENGTH} characters.`}
            >
              <input
                id="account-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={USER_PASSWORD_MIN_LENGTH}
                maxLength={USER_PASSWORD_MAX_LENGTH}
                required
              />
            </Field>
            <Field label="Confirm new password" htmlFor="account-confirm-password">
              <input
                id="account-confirm-password"
                name="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={USER_PASSWORD_MIN_LENGTH}
                maxLength={USER_PASSWORD_MAX_LENGTH}
                required
              />
            </Field>
          </div>
          <button className="button primary align-start" disabled={busy}>
            {busy ? 'Changing password…' : 'Change password'}
          </button>
        </form>
      </Panel>
    </div>
  );
}
