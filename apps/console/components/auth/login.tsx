'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ApiError, apiRequest, type SessionIdentity } from '../../lib/api';
import {
  emailPasswordSession,
  legacyTokenSession,
  USER_PASSWORD_MAX_LENGTH,
  USER_PASSWORD_MIN_LENGTH,
} from '../../lib/user-contract';
import { InlineAlert } from '../ui/feedback-v2';
import { PasswordChange, type PasswordIssue } from './password-change';

type SessionResponse =
  | SessionIdentity
  | {
      identity: SessionIdentity;
      passwordChangeRequired?: true;
      passwordIssues?: PasswordIssue[];
    };

/** Friendlier wording for the sign-in failures an operator actually hits. */
function signInErrorMessage(failure: unknown): string {
  if (failure instanceof ApiError) {
    if (failure.code === 'invalid_credentials') return 'Email or password is incorrect.';
    if (failure.code === 'account_disabled') return 'This account has been disabled.';
    return failure.message;
  }
  return failure instanceof Error ? failure.message : 'Sign-in failed.';
}

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
  /** Held only while a required password change is on screen (OPS-15). */
  const [change, setChange] = useState<{
    email: string;
    password: string;
    issues: PasswordIssue[];
  }>();

  async function signIn(body: unknown, credentials?: { email: string; password: string }) {
    const { data } = await apiRequest<SessionResponse>('/auth/session', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if ('identity' in data && data.passwordChangeRequired && credentials) {
      setChange({ ...credentials, issues: data.passwordIssues ?? [] });
      return;
    }
    setChange(undefined);
    onAuthenticated('identity' in data ? data.identity : data);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const credentials = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    };
    const body = legacy
      ? legacyTokenSession(String(form.get('token') ?? ''))
      : emailPasswordSession(credentials.email, credentials.password);
    if (password.current) password.current.value = '';
    if (token.current) token.current.value = '';
    setSubmitting(true);
    setError(undefined);
    try {
      await signIn(body, legacy ? undefined : credentials);
    } catch (failure) {
      setError(signInErrorMessage(failure));
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
        <div>
          <p className="eyebrow">Management console</p>
          <h1 id="login-title">Sign in</h1>
          <p className="muted">
            Decide whether voice agents are healthy, cheap and compliant — and why one call went
            wrong.
          </p>
        </div>
        {reason && <InlineAlert tone="warn">{reason}</InlineAlert>}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        {change ? (
          <PasswordChange
            issues={change.issues}
            currentPassword={change.password}
            onChanged={(next) =>
              signIn(emailPasswordSession(change.email, next), {
                email: change.email,
                password: next,
              })
            }
          />
        ) : (
          <form onSubmit={submit} className="stack">
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
        )}
        <p className="login-footnote">
          The organization is configured on the server, and your credentials are sent only to this
          self-hosted organization — there is no organization picker or tenant provisioning flow.
          {' · '}
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
        </p>
      </section>
    </main>
  );
}
