'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { SessionIdentity } from '../../lib/api';
import { navigation } from './nav-config';

export function Sidebar({ identity, onNavigate }: { identity: SessionIdentity; onNavigate?: () => void }) {
  const pathname = usePathname();
  const organization = identity.workspace?.name ?? identity.workspaceId ?? 'Self-hosted organization';
  return <aside className="sidebar" aria-label="Application navigation">
    <div className="brand"><strong>ovo</strong><span>VOICE<br/>OPERATIONS</span></div>
    <div className="workspace-switcher"><span>{organization}</span><small>{identity.role} access</small></div>
    {(['Build', 'Operations', 'Settings'] as const).map(group => <div className="nav-group" key={group}>
      <p>{group}</p><nav aria-label={group}>
        {navigation.filter(item => item.group === group && (!('adminOnly' in item) || identity.role === 'admin')).map(item =>
          <Link key={item.href} href={item.href} onClick={onNavigate} className={pathname === item.href || pathname.startsWith(`${item.href}/`) ? 'active' : ''} aria-current={pathname === item.href ? 'page' : undefined}>{item.label}</Link>)}
      </nav>
    </div>)}
    <div className="sidebar-status"><small>API session active</small></div>
  </aside>;
}
