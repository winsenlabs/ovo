import type { ReactNode } from 'react';
import type { SessionIdentity } from '../../lib/api';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { SessionProvider } from './session-provider';

export function AppShell({ identity, children }: { identity: SessionIdentity; children: ReactNode }) {
  return <SessionProvider identity={identity}>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="desktop-nav"><Sidebar identity={identity} /></div>
    <div className="shell"><Topbar identity={identity} /><main id="main" className="content">{children}</main></div>
  </SessionProvider>;
}
