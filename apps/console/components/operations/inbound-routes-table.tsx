import type { SessionIdentity } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import { EmptyState, JsonEvidence, ResponsiveTable, StatusBadge } from '../primitives';
import { formatTime } from '../../lib/format';
const displayTime = formatTime;
export function InboundRoutesTable({ routes, role, busy, onEdit, onRemove }: {
  routes: InboundRouteRecord[]; role: SessionIdentity['role']; busy: boolean;
  onEdit: (route: InboundRouteRecord) => void; onRemove: (route: InboundRouteRecord) => Promise<void>;
}) {
  return <>
        {!routes.length ? (
          <EmptyState title="No inbound number routes">
            An administrator must bind a carrier number to an immutable release before inbound
            admission can resolve an agent configuration.
          </EmptyState>
        ) : (
          <ResponsiveTable label="Configured inbound number routes">
            <thead>
              <tr>
                <th>Phone number</th>
                <th>Immutable release</th>
                <th>Carrier</th>
                <th>State</th>
                <th>Version</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route) => (
                <tr key={route.phoneNumber}>
                  <td className="mono">{route.phoneNumber}</td>
                  <td>
                    <span className="mono">{route.releaseId}</span>
                    <JsonEvidence label="Snapshotted variables" value={route.variables} />
                  </td>
                  <td>{route.carrierPluginId ?? 'Environment'}<small>{route.carrierBindingId ?? 'Environment binding'}</small></td>
                  <td>
                    <StatusBadge tone={route.enabled ? 'good' : 'warning'}>
                      {route.enabled ? 'Enabled' : 'Disabled'}
                    </StatusBadge>
                  </td>
                  <td>
                    v{route.version}
                    <small>{displayTime(route.updatedAt)}</small>
                  </td>
                  <td>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
  </>;
}
