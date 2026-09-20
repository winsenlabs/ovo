'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import type { InfrastructureSnapshot } from '../../lib/operator-api';
import {
  EmptyState,
  Field,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

const value = (item: number | null, suffix = '') =>
  item === null ? 'Unknown' : `${item.toLocaleString()}${suffix}`;
const bytes = (item: number | null) =>
  item === null ? 'Unknown' : `${(item / 1024 / 1024).toFixed(1)} MiB`;

export function InfrastructureView() {
  const [snapshot, setSnapshot] = useState<InfrastructureSnapshot>();
  const [releaseId, setReleaseId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (filter = releaseId) => {
      setLoading(true);
      setError(undefined);
      try {
        const query = filter ? `?${new URLSearchParams({ releaseId: filter })}` : '';
        setSnapshot((await apiRequest<InfrastructureSnapshot>(`/infrastructure${query}`)).data);
      } catch (failure) {
        setSnapshot(undefined);
        setError(
          failure instanceof ApiError && failure.status === 503
            ? 'Infrastructure evidence is not configured for this installation.'
            : failure instanceof Error
              ? failure.message
              : 'Infrastructure evidence could not be loaded.',
        );
      } finally {
        setLoading(false);
      }
    },
    [releaseId],
  );
  useEffect(() => {
    void load('');
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load();
  };
  if (loading && !snapshot) return <LoadingBlock label="Loading infrastructure evidence" />;
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Deployment evidence</p>
          <h1>Infrastructure</h1>
          <p className="muted">
            Read-only PostgreSQL-backed capacity, queue and process evidence. Missing metrics remain
            unknown rather than zero.
          </p>
        </div>
      </header>
      {error && <Notice tone="danger">{error}</Notice>}
      <form className="filter-bar" onSubmit={submit}>
        <Field label="Optional release ID" htmlFor="infrastructure-release">
          <input
            id="infrastructure-release"
            value={releaseId}
            onChange={(event) => setReleaseId(event.target.value)}
          />
        </Field>
        <button className="button" disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh snapshot'}
        </button>
      </form>
      {snapshot && (
        <>
          <Panel labelledBy="installation-status-title">
            <PanelHeader
              id="installation-status-title"
              title="Admission safety"
              badge={
                <StatusBadge
                  tone={
                    snapshot.installation.status === 'ready'
                      ? 'good'
                      : snapshot.installation.status === 'degraded'
                        ? 'warning'
                        : 'danger'
                  }
                >
                  {snapshot.installation.status}
                </StatusBadge>
              }
            />
            <div className="panel-body stack">
              <Notice tone={snapshot.installation.status === 'ready' ? 'neutral' : 'warning'}>
                {snapshot.installation.admissionSafety}
              </Notice>
              {snapshot.installation.reasons.length > 0 && (
                <ul>
                  {snapshot.installation.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              <small>
                Generated {new Date(snapshot.generatedAt).toLocaleString()}
                {snapshot.filter.releaseId ? ` · release ${snapshot.filter.releaseId}` : ''}
              </small>
            </div>
          </Panel>
          <section className="metrics" aria-label="Worker capacity">
            <article>
              <span>Ready idle</span>
              <strong>{value(snapshot.workers.ready)}</strong>
            </article>
            <article>
              <span>Active</span>
              <strong>{value(snapshot.workers.active)}</strong>
            </article>
            <article>
              <span>Reserved</span>
              <strong>{value(snapshot.workers.reserved)}</strong>
            </article>
            <article>
              <span>Starting</span>
              <strong>{value(snapshot.workers.starting)}</strong>
            </article>
            <article>
              <span>Draining</span>
              <strong>{value(snapshot.workers.draining)}</strong>
            </article>
            <article>
              <span>Capacity ceiling</span>
              <strong>{value(snapshot.workers.capacityCeiling)}</strong>
            </article>
          </section>
          <div className="two-column">
            <Panel labelledBy="queue-evidence-title">
              <PanelHeader id="queue-evidence-title" title="Durable queue" />
              <dl className="metadata-list">
                <div>
                  <dt>Depth</dt>
                  <dd>{value(snapshot.queue.depth)}</dd>
                </div>
                <div>
                  <dt>Eligible</dt>
                  <dd>{value(snapshot.queue.eligibleDepth)}</dd>
                </div>
                <div>
                  <dt>Oldest age</dt>
                  <dd>{value(snapshot.queue.oldestAgeMs, ' ms')}</dd>
                </div>
                <div>
                  <dt>Reconciliation</dt>
                  <dd>{value(snapshot.queue.reconciliationDepth)}</dd>
                </div>
                <div>
                  <dt>Unresolved capacity writes</dt>
                  <dd>{value(snapshot.queue.unresolvedCapacityWrites)}</dd>
                </div>
              </dl>
            </Panel>
            <Panel labelledBy="process-evidence-title">
              <PanelHeader id="process-evidence-title" title="Worker process samples" />
              <dl className="metadata-list">
                <div>
                  <dt>CPU average</dt>
                  <dd>{value(snapshot.process.cpuPercentAverage, '%')}</dd>
                </div>
                <div>
                  <dt>RSS total</dt>
                  <dd>{bytes(snapshot.process.memoryRssBytesTotal)}</dd>
                </div>
                <div>
                  <dt>Memory limit</dt>
                  <dd>{bytes(snapshot.process.memoryLimitBytesTotal)}</dd>
                </div>
                <div>
                  <dt>Event-loop lag max</dt>
                  <dd>{value(snapshot.process.eventLoopLagMsMax, ' ms')}</dd>
                </div>
                <div>
                  <dt>Restarts</dt>
                  <dd>{value(snapshot.process.restartsTotal)}</dd>
                </div>
              </dl>
            </Panel>
          </div>
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
          <div className="two-column">
            <Panel labelledBy="recording-ops-title">
              <PanelHeader id="recording-ops-title" title="Recording operations" />
              {snapshot.recordings ? (
                <dl className="metadata-list">
                  <div>
                    <dt>Queued exports</dt>
                    <dd>{snapshot.recordings.queuedExports}</dd>
                  </div>
                  <div>
                    <dt>Running exports</dt>
                    <dd>{snapshot.recordings.runningExports}</dd>
                  </div>
                  <div>
                    <dt>Pending deletion</dt>
                    <dd>{snapshot.recordings.pendingDeletion}</dd>
                  </div>
                  <div>
                    <dt>Failed deletion</dt>
                    <dd>{snapshot.recordings.failedDeletion}</dd>
                  </div>
                  <div>
                    <dt>Finalizing artifacts</dt>
                    <dd>{snapshot.recordings.finalizingArtifacts}</dd>
                  </div>
                  <div>
                    <dt>Failed artifacts</dt>
                    <dd>{snapshot.recordings.failedArtifacts}</dd>
                  </div>
                </dl>
              ) : (
                <div className="panel-body">
                  <Notice>Recording lifecycle metrics are unknown.</Notice>
                </div>
              )}
            </Panel>
            <Panel labelledBy="telemetry-ops-title">
              <PanelHeader id="telemetry-ops-title" title="Telemetry ingestion" />
              {snapshot.telemetry ? (
                <dl className="metadata-list">
                  <div>
                    <dt>Events · 5 min</dt>
                    <dd>{snapshot.telemetry.eventsLastFiveMinutes}</dd>
                  </div>
                  <div>
                    <dt>Active calls</dt>
                    <dd>{snapshot.telemetry.activeCalls}</dd>
                  </div>
                  <div>
                    <dt>Newest event</dt>
                    <dd>
                      {snapshot.telemetry.newestEventAt
                        ? new Date(snapshot.telemetry.newestEventAt).toLocaleString()
                        : 'None'}
                    </dd>
                  </div>
                </dl>
              ) : (
                <div className="panel-body">
                  <Notice>Telemetry metrics are unknown.</Notice>
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
