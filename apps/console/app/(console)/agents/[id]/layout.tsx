import Link from 'next/link';
import type { ReactNode } from 'react';
export default async function AgentLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const prefix = `/agents/${encodeURIComponent(id)}`;
  return <div className="ui-stack"><nav className="ui-tabs" aria-label="Agent sections">
    <Link href={prefix}>Configure</Link><Link href={`${prefix}/plugins`}>Plugins</Link>
    <Link href={`${prefix}/test`}>Test</Link><Link href={`${prefix}/releases`}>Releases</Link>
  </nav>{children}</div>;
}
