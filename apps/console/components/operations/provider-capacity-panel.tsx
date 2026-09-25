import type { InfrastructureSnapshot } from '../../lib/operator-api';
import { EmptyState, Panel, PanelHeader, ResponsiveTable } from '../primitives';
const value = (item: number | null, suffix = '') => item === null ? 'Unknown' : `${item.toLocaleString()}${suffix}`;
export function ProviderCapacityPanel({ snapshot }: { snapshot: InfrastructureSnapshot }) {
  return (
          <Panel labelledBy="provider-capacity-title">
            <PanelHeader id="provider-capacity-title" title="Provider quota and throttling" />
            {snapshot.providers.quotas === null && snapshot.providers.throttling === null ? (
              <div className="panel-body">
                <EmptyState title="Provider metrics unknown">
                  No fresh provider quota or throttle samples were reported.
                </EmptyState>
              </div>
            ) : (
              <ResponsiveTable label="Provider infrastructure evidence">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Metric</th>
                    <th>Remaining/limit</th>
                    <th>Throttle</th>
                    <th>Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot.providers.quotas ?? []).map((quota) => {
                    const throttle = (snapshot.providers.throttling ?? []).find(
                      (item) => item.provider === quota.provider,
                    );
                    return (
                      <tr key={`${quota.provider}:${quota.metric}`}>
                        <td>{quota.provider}</td>
                        <td>{quota.metric}</td>
                        <td>
                          {value(quota.remaining)} / {value(quota.limit)}
                        </td>
                        <td>
                          {throttle
                            ? `${throttle.active ? 'Active' : 'Inactive'} · ${throttle.count}`
                            : 'Unknown'}
                        </td>
                        <td>{new Date(quota.observedAt).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </ResponsiveTable>
            )}
          </Panel>
  );
}
