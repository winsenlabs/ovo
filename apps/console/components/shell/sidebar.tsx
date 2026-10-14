'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { SessionIdentity } from '../../lib/api';
import { NAV_GROUPS, navigation } from './nav-config';
import { NavIcon } from './nav-icons';

const COLLAPSE_KEY = 'ovo-console-nav-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The one sidebar, rendered both as the fixed desktop rail (`variant="desktop"`, default) and
 * inside the mobile drawer (`variant="mobile"`), which always shows full labels and group
 * headings regardless of the desktop collapse preference (brief defect #4 — the mobile drawer
 * used to inherit a narrow-viewport CSS rule meant for the desktop rail and lost its groups).
 */
export function Sidebar({
  identity,
  onNavigate,
  variant = 'desktop',
}: {
  identity: SessionIdentity;
  onNavigate?: () => void;
  variant?: 'desktop' | 'mobile';
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (variant === 'desktop') setCollapsed(readCollapsed());
  }, [variant]);
  // `.shell`'s margin and `.sidebar`'s width both read this one custom property, so the content
  // column and the fixed rail stay in sync without lifting collapse state through `AppShell`.
  useEffect(() => {
    if (variant !== 'desktop') return;
    try {
      document.documentElement.style.setProperty('--ovo-nav-w', collapsed ? '64px' : '232px');
    } catch {
      // Ignore: a blocked style-mutation context just keeps the default width.
    }
  }, [collapsed, variant]);
  const organization =
    identity.workspace?.name ?? identity.workspaceId ?? 'Self-hosted organization';
  const effectiveCollapsed = variant === 'desktop' && collapsed;

  return (
    <aside
      className={`sidebar sidebar--${variant}${effectiveCollapsed ? ' sidebar--collapsed' : ''}`}
      aria-label="Application navigation"
    >
      <div className="brand">
        <strong>ovo</strong>
        {!effectiveCollapsed && (
          <span>
            VOICE
            <br />
            OPERATIONS
          </span>
        )}
      </div>
      {!effectiveCollapsed && (
        <div className="workspace-switcher">
          <span>{organization}</span>
          <small>{identity.role} access</small>
        </div>
      )}
      <div className="sidebar-scroll">
        {NAV_GROUPS.map((group) => {
          const items = navigation.filter(
            (item) => item.group === group && (!item.adminOnly || identity.role === 'admin'),
          );
          if (!items.length) return null;
          return (
            <div className="nav-group" key={group}>
              {!effectiveCollapsed && <p>{group}</p>}
              <nav aria-label={group}>
                {items.map((item) => {
                  const active =
                    pathname === item.href ||
                    (item.href !== '/' && pathname.startsWith(`${item.href}/`));
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onNavigate}
                      className={active ? 'active' : ''}
                      aria-current={active ? 'page' : undefined}
                      title={effectiveCollapsed ? item.label : undefined}
                    >
                      <NavIcon name={item.icon} />
                      {!effectiveCollapsed && <span>{item.label}</span>}
                    </Link>
                  );
                })}
              </nav>
            </div>
          );
        })}
      </div>
      <div className="sidebar-status">
        <Link href="/account" className="sidebar-profile" onClick={onNavigate}>
          <span className="sidebar-profile-avatar" aria-hidden="true">
            {(identity.label ?? identity.name ?? identity.email ?? '?').charAt(0).toUpperCase()}
          </span>
          {!effectiveCollapsed && (
            <span className="sidebar-profile-text">
              <strong>{identity.label ?? identity.name ?? identity.email ?? 'Signed in'}</strong>
              <small>{identity.role}</small>
            </span>
          )}
        </Link>
        {variant === 'desktop' && (
          <button
            type="button"
            className="sidebar-collapse-toggle"
            aria-pressed={collapsed}
            onClick={() => {
              setCollapsed((value) => {
                const next = !value;
                try {
                  if (next) localStorage.setItem(COLLAPSE_KEY, '1');
                  else localStorage.removeItem(COLLAPSE_KEY);
                } catch {
                  // Ignore: a blocked storage context just loses the preference next visit.
                }
                return next;
              });
            }}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
          </button>
        )}
      </div>
    </aside>
  );
}
