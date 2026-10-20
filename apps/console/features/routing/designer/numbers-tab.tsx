'use client';
import { useState } from 'react';
import { DataTableV2, type ColumnV2 } from '../../../components/ui/data-table-v2';
import { EmptyStateV2, InlineAlert } from '../../../components/ui/feedback-v2';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { routingApi } from '../../../lib/data/routing-api';
import { useRoutingLoad } from '../../../lib/data/use-routing-load';
import { bindableNumbers, isBehind, modeLabel, numbersOfPoint } from '../../../lib/derive/routing-numbers';
import { formatPhoneNumber } from '../../../lib/format';
import type { NumberRow } from '../../../lib/types/routing';
import { BindDrawer } from './bind-drawer';

/** The numbers pinned to this point: which release, whether they are behind, and binding (admins). */
export function NumbersTab({
  pointId,
  pointName,
  numbers,
  isAdmin,
  refreshKey,
  onChanged,
}: {
  pointId: string;
  pointName: string;
  numbers: readonly NumberRow[];
  isAdmin: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const releases = useRoutingLoad(() => routingApi.releases(pointId), [pointId, refreshKey]);
  const list = releases.state.status === 'ready' ? releases.state.data : [];
  const mine = numbersOfPoint(numbers, pointId);
  const [binding, setBinding] = useState<{ row?: NumberRow }>();
  const [notice, setNotice] = useState<string>();
  const latest = list.reduce((max, r) => Math.max(max, r.version), 0);
  const columns: ColumnV2<NumberRow>[] = [
    { id: 'number', header: 'Number', cell: (r) => <strong>{formatPhoneNumber(r.phoneNumber)}</strong> },
    { id: 'mode', header: 'Answered by', cell: (r) => <StatusBadgeV2 tone="info" size="sm" label={modeLabel(r)} /> },
    {
      id: 'release',
      header: 'Release',
      cell: (r) => (
        <span className="rt-badges">
          v{r.routing?.version ?? '—'}
          {isBehind(r, list) && <StatusBadgeV2 tone="warn" size="sm" label={`Behind (latest v${latest})`} />}
        </span>
      ),
    },
    { id: 'enabled', header: 'State', priority: 'low', cell: (r) => <StatusBadgeV2 tone={r.enabled ? 'ok' : 'neutral'} size="sm" label={r.enabled ? 'Live' : 'Disabled'} /> },
    {
      id: 'actions',
      header: 'Actions',
      cell: (r) =>
        isAdmin ? (
          <span className="button-row">
            {isBehind(r, list) && (
              <button type="button" className="button small" aria-label={`Bind ${formatPhoneNumber(r.phoneNumber)} to latest`} onClick={() => setBinding({ row: r })}>
                Bind to latest
              </button>
            )}
            <button type="button" className="button small" aria-label={`Change release of ${formatPhoneNumber(r.phoneNumber)}`} onClick={() => setBinding({ row: r })}>
              Change release
            </button>
          </span>
        ) : null,
    },
  ];
  return (
    <div className="rt-stack rt-pad">
      <div className="rt-toolbar">
        <p className="muted">
          A number answers with the routing release it is bound to. Publishing changes nothing for callers until the number is bound to the new release.
        </p>
        {isAdmin && (
          <button type="button" className="button primary" onClick={() => setBinding({})}>
            Bind a number
          </button>
        )}
      </div>
      {!isAdmin && <InlineAlert tone="info">Only admins can bind numbers.</InlineAlert>}
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}
      <DataTableV2
        label="Numbers on this point"
        rows={mine}
        columns={columns}
        rowKey={(r) => r.phoneNumber}
        empty={<EmptyStateV2 title="No numbers on this point yet">Bind a number to a release to send its callers through this point. Until then it answers as it does today.</EmptyStateV2>}
      />
      <BindDrawer
        open={binding !== undefined}
        candidates={binding?.row ? [binding.row] : bindableNumbers(numbers, pointId)}
        initial={binding?.row}
        releases={list}
        pointName={pointName}
        onClose={() => setBinding(undefined)}
        onBound={(message) => {
          setBinding(undefined);
          setNotice(message);
          onChanged();
        }}
      />
    </div>
  );
}
