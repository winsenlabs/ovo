'use client';
import { useSession } from '../../../components/shell/session-provider';
import { DesignerView } from './designer-view';

export function DesignerFeature({ pointId }: { pointId: string }) {
  const identity = useSession();
  return <DesignerView pointId={pointId} role={identity.role} />;
}
