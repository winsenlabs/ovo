'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import { apiRequest, ApiError, type SessionIdentity } from '../lib/api';
import { AgentStudio } from './studio';
import { Integrations } from './integrations';
import { Operations } from './operations';
import { LoadingBlock, Notice, StatusBadge } from './primitives';

type SessionState =
  | { status: 'checking' }
  | { status: 'signedOut'; reason?: string }
  | { status: 'ready'; identity: SessionIdentity }
  | { status: 'error'; message: string };

const navigation = [
  { href: '/agents', label: 'Agents', group: 'Workspace' },
  { href: '/calls', label: 'Calls', group: 'Workspace' },
  { href: '/tools', label: 'Tools', group: 'Workspace' },
  { href: '/providers', label: 'Providers & secrets', group: 'Workspace' },
  { href: '/evaluations', label: 'Evaluations', group: 'Operations' },
  { href: '/performance', label: 'Performance', group: 'Operations' },
  { href: '/infrastructure', label: 'Infrastructure', group: 'Operations' },
];

function Login({
  onAuthenticated,
  reason,
}: {
  onAuthenticated: (identity: SessionIdentity) => void;
  reason?: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const token = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const bootstrapToken = String(form.get('token') ?? '');
    const workspaceId = String(form.get('workspaceId') ?? '').trim();
    if (token.current) token.current.value = '';
    setSubmitting(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<SessionIdentity | { identity: SessionIdentity }>(
        '/auth/session',
        {
          method: 'POST',
          body: JSON.stringify({ token: bootstrapToken, ...(workspaceId ? { workspaceId } : {}) }),
        },
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
        <h1 id="login-title">Start a secure session</h1>
        <p className="muted">
          The bootstrap token is posted once to the management API. It is cleared from this form and
          never stored by the console.
        </p>
        {reason && <Notice tone="warning">{reason}</Notice>}
        {error && (
          <Notice tone="danger" live>
            {error}
          </Notice>
        )}
        <form onSubmit={submit} autoComplete="off">
          <label htmlFor="bootstrap-token">Bootstrap token</label>
          <input
            ref={token}
            id="bootstrap-token"
            name="token"
            type="password"
            autoComplete="off"
            required
            spellCheck={false}
          />
          <label htmlFor="workspace-id">
            Workspace ID <span className="muted">(optional)</span>
          </label>
          <input id="workspace-id" name="workspaceId" autoComplete="off" />
          <button className="button primary" disabled={submitting}>
            {submitting ? 'Starting session…' : 'Continue'}
          </button>
        </form>
        <small>
          Authentication and workspace membership are enforced by the API. This console does not
          read an admin token from browser-visible environment variables.
        </small>
      </section>
    </main>
  );
}

export function ConsoleApp({
  activeView,
  extensions,
}: {
  activeView: string;
  extensions: readonly ConsoleExtension[];
}) {
  const [session, setSession] = useState<SessionState>({ status: 'checking' });

  useEffect(() => {
    let current = true;
    apiRequest<SessionIdentity>('/auth/me')
      .then(({ data }) => current && setSession({ status: 'ready', identity: data }))
      .catch(
        (error) =>
          current &&
          setSession(
            error instanceof ApiError && error.status === 401
              ? { status: 'signedOut' }
              : {
                  status: 'error',
                  message: error instanceof Error ? error.message : 'Session check failed.',
                },
          ),
      );
    return () => {
      current = false;
    };
  }, []);

  if (session.status === 'checking')
    return (
      <main className="centered">
        <LoadingBlock label="Checking session" />
      </main>
    );
  if (session.status === 'signedOut')
    return (
      <Login
        reason={session.reason}
        onAuthenticated={(identity) => setSession({ status: 'ready', identity })}
      />
    );
  if (session.status === 'error')
    return (
      <main className="centered">
        <Notice tone="danger">{session.message}</Notice>
        <button className="button" onClick={() => location.reload()}>
          Retry
        </button>
      </main>
    );

  const identity = session.identity;
  const workspaceName =
    identity.workspace?.name ??
    identity.workspaceId ??
    identity.workspace?.id ??
    'Selected workspace';
  async function logout() {
    try {
      await apiRequest('/auth/session', { method: 'DELETE' });
    } finally {
      setSession({ status: 'signedOut', reason: 'The local session ended.' });
    }
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Application navigation">
        <div className="brand">
          <strong>ovo</strong>
          <span>
            VOICE
            <br />
            OPERATIONS
          </span>
        </div>
        <div className="workspace-switcher">
          <span>{workspaceName}</span>
          <small>{identity.role} access</small>
        </div>
        {['Workspace', 'Operations'].map((group) => (
          <div key={group} className="nav-group">
            <p>{group}</p>
            <nav aria-label={group}>
              {navigation
                .filter((item) => item.group === group)
                .map((item) => {
                  const selected = item.href === `/${activeView}`;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={selected ? 'active' : ''}
                      aria-current={selected ? 'page' : undefined}
                    >
                      {item.label}
                    </Link>
                  );
                })}
            </nav>
          </div>
        ))}
        <div className="sidebar-status">
          <StatusBadge tone="good">API session active</StatusBadge>
          <small>Live evidence still depends on each API source.</small>
        </div>
      </aside>
      <div className="shell">
        <header className="topbar">
          <div>
            <span className="muted">OVO</span>
            <span aria-hidden="true"> / </span>
            <strong>
              {navigation.find((item) => item.href === `/${activeView}`)?.label ?? 'Agents'}
            </strong>
          </div>
          <div className="topbar-actions">
            <StatusBadge tone="soft">Test environment</StatusBadge>
            <span className="operator">
              {identity.name ?? identity.label ?? identity.email ?? identity.role}
            </span>
            <button className="text-button" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>
        <main id="main" className="content">
          {activeView === 'agents' && <AgentStudio extensions={extensions} identity={identity} />}
          {(activeView === 'providers' || activeView === 'tools') && (
            <Integrations initialTab={activeView} identity={identity} />
          )}
          {['calls', 'evaluations', 'performance', 'infrastructure'].includes(activeView) && (
            <Operations view={activeView} extensions={extensions} role={identity.role} />
          )}
        </main>
      </div>
    </>
  );
}
