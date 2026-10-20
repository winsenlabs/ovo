'use client';
import { useSession } from '../../components/shell/session-provider';
import { RoutingOverview } from './routing-overview';

export function RoutingOverviewFeature() {
  const identity = useSession();
  return <RoutingOverview role={identity.role} />;
}
