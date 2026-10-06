'use client';

import { useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import { USER_PASSWORD_MAX_LENGTH, USER_PASSWORD_MIN_LENGTH } from '../../lib/user-contract';
import { Notice } from '../primitives';

export interface PasswordIssue {
  code: string;
  message: string;
}

/** Character classes a new password mixes; the server's policy wants three, or 20+ characters. */
export function passwordClasses(password: string): number {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password))
    .length;
}

/**
 * OPS-15: shown after a sign-in whose password fails the policy or is still the server's bootstrap
 * password. That session reaches nothing else; the change revokes it, so the console signs in
 * again with the new password.
 */
export function PasswordChange({
  issues,
  currentPassword,
  onChanged,
}: {
  issues: readonly PasswordIssue[];
  currentPassword: string;
  onChanged: (newPassword: string) => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = String(form.get('newPassword') ?? '');
    if (next !== String(form.get('confirmPassword') ?? ''))
      return setError('The two new passwords differ.');
    if (next === currentPassword) return setError('Choose a password you have not used here.');
    if (passwordClasses(next) < 3 && next.length < 20)
      return setError(
        'Mix three of lowercase, uppercase, digits and symbols, or use 20+ characters.',
      );
    setSubmitting(true);
    setError(undefined);
    try {
      await apiRequest('/auth/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword: next }),
      });
      await onChanged(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The password could not be changed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Notice tone="warning">
        <strong>Change your password to continue.</strong>
        <ul>
          {issues.map((issue) => (
            <li key={issue.code}>{issue.message}</li>
          ))}
        </ul>
      </Notice>
      {error && (
        <Notice tone="danger" live>
          {error}
        </Notice>
      )}
      <form onSubmit={submit}>
        <label htmlFor="new-password">New password</label>
        <input
          id="new-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={USER_PASSWORD_MIN_LENGTH}
          maxLength={USER_PASSWORD_MAX_LENGTH}
          required
        />
        <label htmlFor="confirm-password">Confirm new password</label>
        <input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={USER_PASSWORD_MIN_LENGTH}
          maxLength={USER_PASSWORD_MAX_LENGTH}
          required
        />
        <button className="button primary" disabled={submitting}>
          {submitting ? 'Changing…' : 'Change password and sign in'}
        </button>
      </form>
    </>
  );
}
