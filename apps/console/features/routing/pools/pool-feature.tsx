'use client';
import { useSession } from '../../../components/shell/session-provider';
import { PoolEditor } from './pool-editor';

export function PoolFeature({ poolId }: { poolId: string }) {
  const identity = useSession();
  return <PoolEditor poolId={poolId} role={identity.role} />;
}
