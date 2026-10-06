'use client';
import { CallbacksView } from '../../../../components/operations/callbacks-view';
import { useSession } from '../../../../components/shell/session-provider';

export default function Page() {
  const identity = useSession();
  return <CallbacksView role={identity.role} />;
}
