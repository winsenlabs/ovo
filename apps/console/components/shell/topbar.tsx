'use client';
import { usePathname, useRouter } from 'next/navigation';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import { navigation } from './nav-config';
import { MobileNav } from './mobile-nav';

export function Topbar({ identity }: { identity: SessionIdentity }) {
  const pathname = usePathname();
  const router = useRouter();
  const title = navigation.find(item => pathname === item.href || pathname.startsWith(`${item.href}/`))?.label ?? 'OVO';
  async function logout() { await apiRequest('/auth/session', { method: 'DELETE' }).catch(() => undefined); router.replace('/login'); router.refresh(); }
  return <header className="topbar"><div className="topbar-location"><MobileNav identity={identity} /><span className="muted">OVO / </span><strong>{title}</strong></div>
    <div className="topbar-actions"><span className="operator">{identity.name ?? identity.label ?? identity.email ?? identity.role}</span><button type="button" className="text-button" onClick={logout}>Sign out</button></div>
  </header>;
}
