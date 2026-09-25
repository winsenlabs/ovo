import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { loadConsoleExtensions } from '@winsendotai/ovo-ui';
import { AppShell } from '../../components/shell/app-shell';
import { serverSession } from '../../lib/session';

export const dynamic = 'force-dynamic';
export const consoleExtensions = loadConsoleExtensions();

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await serverSession();
  if (session.status === 401 || session.status === 403) {
    const header = await headers();
    const path = header.get('x-ovo-console-path') ?? '/agents';
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  if (!session.identity) throw new Error('Management API session check unavailable');
  return <AppShell identity={session.identity}>{children}</AppShell>;
}
