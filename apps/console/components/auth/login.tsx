'use client';

import { useRef, useState, type FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import {
  emailPasswordSession,
  legacyTokenSession,
  USER_PASSWORD_MAX_LENGTH,
  USER_PASSWORD_MIN_LENGTH,
} from '../../lib/user-contract';
import { Notice } from '../primitives';

export function Login({
  onAuthenticated,
  reason,
}: {
  onAuthenticated: (identity: SessionIdentity) => void;
  reason?: string;
}) {
  const [legacy, setLegacy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const password = useRef<HTMLInputElement>(null);
  const token = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = legacy
      ? legacyTokenSession(String(form.get('token') ?? ''))
      : emailPasswordSession(String(form.get('email') ?? ''), String(form.get('password') ?? ''));
    if (password.current) password.current.value = '';
    if (token.current) token.current.value = '';
    setSubmitting(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<SessionIdentity | { identity: SessionIdentity }>(
        '/auth/session',
        { method: 'POST', body: JSON.stringify(body) },
      );
      onAuthenticated('identity' in data ? data.identity : data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page" id="main">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand login-brand">
          <strong>ovo</strong>
          <span>
            VOICE
            <br />
            OPERATIONS
          </span>
        </div>
        <p className="eyebrow">Management console</p>
        <h1 id="login-title">Sign in</h1>
        <p className="muted">
          Use the email and password for this self-hosted organization. Credentials are sent only to
          the management API and are never stored by the console.
        </p>
        {reason && <Notice tone="warning">{reason}</Notice>}
        {error && (
          <Notice tone="danger" live>
            {error}
          </Notice>
        )}
        <form onSubmit={submit}>
          {legacy ? (
            <>
              <label htmlFor="bootstrap-token">Legacy bootstrap token</label>
              <input
                ref={token}
                id="bootstrap-token"
                name="token"
                type="password"
                autoComplete="off"
                required
                spellCheck={false}
              />
            </>
          ) : (
            <>
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                name="email"
                type="email"
                autoComplete="username"
                maxLength={254}
                required
                spellCheck={false}
              />
              <label htmlFor="login-password">Password</label>
              <input
                ref={password}
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                minLength={USER_PASSWORD_MIN_LENGTH}
                maxLength={USER_PASSWORD_MAX_LENGTH}
                required
              />
            </>
          )}
          <button className="button primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <details>
          <summary>Legacy local fixture access</summary>
          <p className="muted">
            Existing local fixtures may still use a server-configured bootstrap token. New
            installations should use email and password.
          </p>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              if (password.current) password.current.value = '';
              if (token.current) token.current.value = '';
              setLegacy((current) => !current);
              setError(undefined);
            }}
          >
            {legacy ? 'Use email and password' : 'Use a legacy bootstrap token'}
          </button>
        </details>
        <small>
          The organization is configured on the server. This console has no organization picker or
          tenant provisioning flow.
        </small>
      </section>
    </main>
  );
}
