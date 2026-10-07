'use client';
import { useSession } from '../components/shell/session-provider';
import { ComplianceView } from '../components/compliance/compliance-view';

export function ComplianceFeature() {
  const identity = useSession();
  return <ComplianceView role={identity.role} />;
}
