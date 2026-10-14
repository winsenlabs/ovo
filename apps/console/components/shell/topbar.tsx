'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import { matchNavItem } from './nav-config';
import { MobileNav } from './mobile-nav';
import { ThemeToggle } from '../ui/theme-toggle';

/**
 * The one topbar. Breadcrumb reflects the matched route's group and page label (brief defect #c
 * — it used to just echo the nav label with a static "OVO /" prefix and no trail at all on
 * routes with no exact nav-config match, such as the call inspector). A page that needs a
 * deeper, entity-aware trail (e.g. "Agents / EMI reminder / Plugins") adds its own `PageHeader`
 * breadcrumb in `main`; this one is the shell-level fallback every route gets for free.
 */
export function Topbar({ identity }: { identity: SessionIdentity }) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const match = matchNavItem(pathname);

  async function logout() {
    setSigningOut(true);
    await apiRequest('/auth/session', { method: 'DELETE' }).catch(() => undefined);
    router.replace('/login');
    router.refresh();
  }

  return (
    <header className="topbar">
      <div className="topbar-location">
        <MobileNav identity={identity} />
        <nav aria-label="Breadcrumb" className="topbar-breadcrumb">
          {match ? (
            <>
              <span className="muted">{match.group}</span>
              <span className="muted" aria-hidden="true">
                /
              </span>
              <strong aria-current="page">{match.label}</strong>
            </>
          ) : (
            <strong aria-current="page">OVO</strong>
          )}
        </nav>
      </div>
      <div className="topbar-actions">
        <ThemeToggle />
        <details className="topbar-user">
          <summary>
            <span className="sidebar-profile-avatar" aria-hidden="true">
              {(identity.label ?? identity.name ?? identity.email ?? '?').charAt(0).toUpperCase()}
            </span>
            <span className="operator">
              {identity.name ?? identity.label ?? identity.email ?? identity.role}
            </span>
          </summary>
          <div className="topbar-user-menu" role="menu">
            <Link href="/account" role="menuitem">
              Account
            </Link>
            <button type="button" role="menuitem" onClick={logout} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
