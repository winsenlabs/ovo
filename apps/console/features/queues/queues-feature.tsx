'use client';
import { useSession } from '../../components/shell/session-provider';
import { QueuesView } from './queues-view';

export function QueuesFeature() {
  const identity = useSession();
  return <QueuesView role={identity.role} />;
}
