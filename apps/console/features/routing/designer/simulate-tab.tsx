'use client';
import { useDesigner } from './designer-context';
import { SimulatePanel } from '../simulate/simulate-panel';
import type { ReleaseSummary } from '../../../lib/types/routing';

/** The Simulate tab: the same tester, running the working copy (unsaved edits included). */
export function SimulateTab({ pointId, pointName, releases, role }: { pointId: string; pointName: string; releases: readonly ReleaseSummary[]; role: 'viewer' | 'editor' | 'admin' }) {
  const { draft, status, pools } = useDesigner();
  return (
    <div className="rt-pad">
      <SimulatePanel pointId={pointId} pointName={pointName} draft={draft} releases={releases} status={status} role={role} pools={pools} />
    </div>
  );
}
