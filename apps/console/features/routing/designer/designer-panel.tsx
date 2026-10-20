'use client';
import type { SessionIdentity } from '../../../lib/api';
import type { NumberRow, ReleaseSummary } from '../../../lib/types/routing';
import { HoldTransferTab } from './hold-transfer-tab';
import { LinesTab } from './lines-tab';
import { NumbersTab } from './numbers-tab';
import { QueuesTab } from './queues-tab';
import { ReleasesTab } from './releases-tab';
import { SimulateTab } from './simulate-tab';
import { TreeTab } from './tree-tab';

/** The body of the active designer tab. */
export function DesignerPanel({
  tab,
  pointId,
  pointName,
  role,
  openId,
  onOpen,
  numbers,
  releases,
  refresh,
  onChanged,
  onPublish,
}: {
  tab: string;
  pointId: string;
  pointName: string;
  role: SessionIdentity['role'];
  openId: string | undefined;
  onOpen: (id: string | undefined) => void;
  numbers: readonly NumberRow[];
  releases: readonly ReleaseSummary[];
  refresh: number;
  onChanged: () => void;
  onPublish: () => void;
}) {
  switch (tab) {
    case 'lines':
      return <LinesTab />;
    case 'hold':
      return <HoldTransferTab pointId={pointId} />;
    case 'queues':
      return <QueuesTab />;
    case 'numbers':
      return <NumbersTab pointId={pointId} pointName={pointName} numbers={numbers} isAdmin={role === 'admin'} refreshKey={refresh} onChanged={onChanged} />;
    case 'releases':
      return <ReleasesTab pointId={pointId} numbers={numbers} canEdit={role !== 'viewer'} refreshKey={refresh} onPublish={onPublish} />;
    case 'simulate':
      return <SimulateTab pointId={pointId} pointName={pointName} releases={releases} role={role} />;
    default:
      return <TreeTab openId={openId} onOpen={onOpen} />;
  }
}
