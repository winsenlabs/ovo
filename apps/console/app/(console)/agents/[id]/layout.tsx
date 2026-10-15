import type { ReactNode } from 'react';
import { AgentShell } from '../../../../components/studio/agent-shell';

export default async function AgentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentShell id={id}>{children}</AgentShell>;
}
