import type { SessionIdentity } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import type { ReleaseOption } from './agent-release-options';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { IdChip } from '../ui/section-card';
import { RelativeTime } from '../ui/display';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { formatPhoneNumber } from '../../lib/format';

/** Maps `releaseId` to the agent that owns it, so the table never shows a bare UUID for "agent". */
export function releaseAgentName(
  route: InboundRouteRecord,
  releases: readonly ReleaseOption[],
): string | undefined {
  return releases.find((release) => release.id === route.releaseId)?.agentName;
}

export function InboundRoutesTable({
  routes,
  releases,
  role,
  busy,
  onEdit,
  onRemove,
}: {
  routes: InboundRouteRecord[];
  releases: readonly ReleaseOption[];
  role: SessionIdentity['role'];
  busy: boolean;
  onEdit: (route: InboundRouteRecord) => void;
  onRemove: (route: InboundRouteRecord) => Promise<void>;
}) {
  const columns: ColumnV2<InboundRouteRecord>[] = [
    {
      id: 'phoneNumber',
      header: 'Phone number',
      cell: (route) => <span className="mono">{formatPhoneNumber(route.phoneNumber)}</span>,
      sortValue: (route) => route.phoneNumber,
    },
    {
      id: 'release',
      header: 'Agent & release',
      cell: (route) => (
        <>
          {releaseAgentName(route, releases) ?? <span className="ds-unknown">Unknown agent</span>}
          <br />
          <IdChip id={route.releaseId} short={route.releaseId.slice(0, 12)} />
        </>
      ),
    },
    {
      id: 'carrier',
      header: 'Carrier',
      cell: (route) => (
        <>
          {route.carrierPluginId ?? 'Environment'}
          {route.carrierBindingId && (
            <>
              <br />
              <small className="muted">{route.carrierBindingId}</small>
            </>
          )}
        </>
      ),
    },
    {
      id: 'variables',
      header: 'Variables',
      cell: (route) => {
        const count = Object.keys(route.variables).length;
        return count ? (
          <span title={JSON.stringify(route.variables)}>{count} set</span>
        ) : (
          <span className="ds-unknown">None</span>
        );
      },
    },
    {
      id: 'state',
      header: 'State',
      cell: (route) => (
        <StatusBadgeV2
          tone={route.enabled ? 'ok' : 'warn'}
          label={route.enabled ? 'Enabled' : 'Disabled'}
        />
      ),
      sortValue: (route) => (route.enabled ? 1 : 0),
    },
    {
      id: 'updated',
      header: 'Updated',
      cell: (route) => (
        <>
          v{route.version}
          <br />
          <RelativeTime value={route.updatedAt} />
        </>
      ),
      sortValue: (route) => route.updatedAt,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (route) => (
        <div className="button-row">
          <button className="button small" type="button" onClick={() => onEdit(route)}>
            Edit
          </button>
          <button
            className="button small danger"
            type="button"
            onClick={() => void onRemove(route)}
            disabled={role !== 'admin' || busy}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];
  return (
    <DataTableV2
      // `key` forces a fresh mount on the empty <-> populated transition: DataTableV2 calls
      // `useRef`/`useEffect` only on its non-empty branch (after the empty/loading/error early
      // returns), so reusing the same fiber across that transition throws "Rendered more hooks
      // than during the previous render" the moment the first page of routes arrives. Logged as
      // a foundation defect; this is the local workaround until it is fixed upstream.
      key={routes.length === 0 ? 'empty' : 'data'}
      label="Configured inbound number routes"
      rows={routes}
      columns={columns}
      rowKey={(route) => route.phoneNumber}
      empty={
        <EmptyStateV2 title="No inbound number routes">
          An administrator must bind a carrier number to an immutable release before inbound
          admission can resolve an agent configuration.
        </EmptyStateV2>
      }
    />
  );
}
