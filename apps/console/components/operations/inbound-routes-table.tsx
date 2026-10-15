import type { SessionIdentity, ProviderBinding } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import type { PluginOption } from '../plugins/types';
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

/** Maps `carrierPluginId`/`carrierBindingId` to the labels an operator actually recognises,
 * instead of the package id or the raw binding id (brief defect #8). */
function carrierLabel(
  route: InboundRouteRecord,
  carriers: readonly PluginOption[],
  bindings: readonly ProviderBinding[],
): { plugin: string; binding?: string } {
  if (!route.carrierPluginId) return { plugin: 'Environment' };
  const plugin = carriers.find((candidate) => candidate.id === route.carrierPluginId);
  const binding = route.carrierBindingId
    ? bindings.find((candidate) => candidate.id === route.carrierBindingId)
    : undefined;
  return {
    plugin: plugin?.ui?.label ?? route.carrierPluginId,
    binding: route.carrierBindingId ? (binding?.label ?? route.carrierBindingId) : undefined,
  };
}

export function InboundRoutesTable({
  routes,
  releases,
  carriers,
  bindings,
  role,
  busy,
  loading = false,
  onEdit,
  onRemove,
}: {
  routes: InboundRouteRecord[];
  releases: readonly ReleaseOption[];
  carriers: readonly PluginOption[];
  bindings: readonly ProviderBinding[];
  role: SessionIdentity['role'];
  busy: boolean;
  loading?: boolean;
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
      cell: (route) => {
        const label = carrierLabel(route, carriers, bindings);
        return (
          <>
            {label.plugin}
            {label.binding && (
              <>
                <br />
                <small className="muted">{label.binding}</small>
              </>
            )}
          </>
        );
      },
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
      // `key` forces a fresh mount across any loading/empty/populated transition: DataTableV2
      // calls `useRef`/`useEffect` only on its fully-rendered branch (after the empty/loading/
      // error early returns), so reusing the same fiber across one of those transitions throws
      // "Rendered fewer/more hooks than during the previous render". Logged as a foundation
      // defect; this is the local workaround until it is fixed upstream. Every state that can
      // follow another must get its own key, not just empty vs. populated.
      key={loading ? 'loading' : routes.length === 0 ? 'empty' : 'data'}
      label="Configured inbound number routes"
      rows={routes}
      columns={columns}
      rowKey={(route) => route.phoneNumber}
      loading={loading}
      empty={
        <EmptyStateV2 title="No inbound number routes">
          An administrator must bind a carrier number to an immutable release before inbound
          admission can resolve an agent configuration.
        </EmptyStateV2>
      }
    />
  );
}
