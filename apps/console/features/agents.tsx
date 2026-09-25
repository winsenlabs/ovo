'use client';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import { AgentStudio } from '../components/studio';
import { useSession } from '../components/shell/session-provider';
export function AgentsFeature({ extensions }: { extensions: readonly ConsoleExtension[] }) {
  const identity = useSession();
  return <AgentStudio identity={identity} extensions={extensions} />;
}
