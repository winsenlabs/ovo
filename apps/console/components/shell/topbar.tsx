'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
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
  const menu = useRef<HTMLDetailsElement>(null);

  async function logout() {
    setSigningOut(true);
    await apiRequest('/auth/session', { method: 'DELETE' }).catch(() => undefined);
    router.replace('/login');
    router.refresh();
  }

  // The account menu is a native <details>, so its one source of truth is the `open` attribute —
  // closing it anywhere below is just setting that attribute, never component state (brief
  // defect #9: it used to stay open after picking Account, after an outside click and after
  // Escape, because nothing ever closed it).
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);
  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) {
        menu.current.open = false;
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

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
        <details className="topbar-user" ref={menu}>
          <summary aria-label="Account menu">
            <span className="sidebar-profile-avatar" aria-hidden="true">
              {(identity.label ?? identity.name ?? identity.email ?? '?').charAt(0).toUpperCase()}
            </span>
            <span className="operator">
              {identity.label ?? identity.name ?? identity.email ?? identity.role}
            </span>
          </summary>
          <div className="topbar-user-menu">
            <Link href="/account">Account</Link>
            <button type="button" onClick={logout} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
