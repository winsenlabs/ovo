'use client';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import { AgentStudio } from '../components/studio';
import { useSession } from '../components/shell/session-provider';

export function AgentConfigureFeature({
  agentId,
  extensions,
}: {
  agentId: string;
  extensions: readonly ConsoleExtension[];
}) {
  const identity = useSession();
  return <AgentStudio agentId={agentId} identity={identity} extensions={extensions} />;
}
