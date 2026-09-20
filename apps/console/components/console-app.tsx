'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import { apiRequest, ApiError, type SessionIdentity } from '../lib/api';
import { Login } from './auth/login';
import { AgentStudio } from './studio';
import { Integrations } from './integrations';
import { Operations } from './operations';
import { LoadingBlock, Notice, StatusBadge } from './primitives';
import { AccountView } from './team/account-view';
import { TeamView } from './team/team-view';

type SessionState =
  | { status: 'checking' }
  | { status: 'signedOut'; reason?: string }
  | { status: 'ready'; identity: SessionIdentity }
  | { status: 'error'; message: string };

const navigation = [
  { href: '/agents', label: 'Agents', group: 'Build' },
  { href: '/tools', label: 'Tools', group: 'Build' },
  { href: '/providers', label: 'Providers & secrets', group: 'Build' },
  { href: '/calls', label: 'Calls', group: 'Operations' },
  { href: '/campaigns', label: 'Campaigns', group: 'Operations' },
  { href: '/suppressions', label: 'Suppressions', group: 'Operations' },
  { href: '/handoffs', label: 'Handoffs & inbound', group: 'Operations' },
  { href: '/evaluations', label: 'Evaluations', group: 'Operations' },
  { href: '/performance', label: 'Performance', group: 'Operations' },
  { href: '/costs', label: 'Costs & budgets', group: 'Operations' },
  { href: '/infrastructure', label: 'Infrastructure', group: 'Operations' },
  { href: '/account', label: 'Account', group: 'Settings' },
  { href: '/team', label: 'Team', group: 'Settings', adminOnly: true },
];

const roleLabel = (role: SessionIdentity['role']) =>
  role === 'admin' ? 'Admin' : role === 'editor' ? 'User' : 'Viewer';

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

  useEffect(() => {
    const sessionEnded = () =>
      setSession({ status: 'signedOut', reason: 'Your session ended. Sign in again to continue.' });
    window.addEventListener('ovo:session-ended', sessionEnded);
    return () => window.removeEventListener('ovo:session-ended', sessionEnded);
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
  const organizationName =
    identity.workspace?.name ??
    identity.workspaceId ??
    identity.workspace?.id ??
    'Self-hosted organization';
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
          <span>{organizationName}</span>
          <small>{roleLabel(identity.role)} access</small>
        </div>
        {['Build', 'Operations', 'Settings'].map((group) => (
          <div key={group} className="nav-group">
            <p>{group}</p>
            <nav aria-label={group}>
              {navigation
                .filter(
                  (item) =>
                    item.group === group && (!('adminOnly' in item) || identity.role === 'admin'),
                )
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
            <StatusBadge tone="soft">Self-hosted</StatusBadge>
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
          {[
            'calls',
            'campaigns',
            'suppressions',
            'handoffs',
            'evaluations',
            'performance',
            'costs',
            'infrastructure',
          ].includes(activeView) && (
            <Operations view={activeView} extensions={extensions} role={identity.role} />
          )}
          {activeView === 'account' && (
            <AccountView
              identity={identity}
              onSessionRevoked={(reason) => setSession({ status: 'signedOut', reason })}
            />
          )}
          {activeView === 'team' && (
            <TeamView
              identity={identity}
              onSessionRevoked={(reason) => setSession({ status: 'signedOut', reason })}
            />
          )}
        </main>
      </div>
    </>
  );
}
