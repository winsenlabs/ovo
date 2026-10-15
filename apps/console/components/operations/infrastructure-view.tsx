'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import type { InfrastructureSnapshot } from '../../lib/operator-api';
import { isStale, pushHistory, type HistoryPoint } from '../../lib/derive/infrastructure';
import { formatDateTime, formatDuration, formatRelativeTime } from '../../lib/format';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { StatusBadgeV2 } from '../ui/status-badge';
import { Switch } from '../ui/display';
import { Select } from '../ui/inputs';
import { InlineAlert, Skeleton } from '../ui/feedback-v2';
import { SectionCard } from '../ui/section-card';
import { Sparkline } from '../charts/sparkline';
import { InfrastructureCapacityPanel } from './infrastructure-capacity-panel';
import { ProviderCapacityPanel } from './provider-capacity-panel';
import { InfrastructureOpsPanel } from './infrastructure-ops-panel';
import { loadAgentReleaseOptions, type ReleaseOption } from './agent-release-options';
import styles from './insights-grid.module.css';

const REFRESH_MS = 15_000;
const STALE_QUEUE_AGE_MS = 60_000;

/**
 * Infrastructure: a status header, a degraded banner when unhealthy, a KPI strip with in-session
 * sparklines ("since you opened this page" — the snapshot itself is a point in time), the
 * capacity/quota/process detail panels, and an optional 15s auto-refresh. Replaces a free-text
 * "optional release ID" box and six bare metric tiles with no proportion (brief defects #17, #18).
 */
export function InfrastructureView() {
  const [releaseId, setReleaseId] = useState('');
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  const [snapshot, setSnapshot] = useState<InfrastructureSnapshot | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [history, setHistory] = useState<readonly HistoryPoint[]>([]);
  const historyRef = useRef<readonly HistoryPoint[]>([]);

  useEffect(() => {
    void loadAgentReleaseOptions()
      .then(setReleases)
      .catch(() => setReleases([]));
  }, []);

  const load = useCallback(
    async (filter = releaseId) => {
      try {
        const query = filter ? `?${new URLSearchParams({ releaseId: filter })}` : '';
        const { data } = await apiRequest<InfrastructureSnapshot>(`/infrastructure${query}`);
        setSnapshot(data);
        historyRef.current = pushHistory(historyRef.current, data);
        setHistory(historyRef.current);
        setError(undefined);
      } catch (failure) {
        setSnapshot(null);
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
    void load();
  }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const stale = (snapshot?.queue.oldestAgeMs ?? 0) > STALE_QUEUE_AGE_MS;
  // The API gives an actual max age to judge the heartbeat against, but nothing compared the two
  // (verifier minor #16 — "a heartbeat 11 minutes old against a 15-second maximum gets no stale
  // badge"); `oldestAgeMs`/`STALE_QUEUE_AGE_MS` above is a different signal (queue backlog), not
  // a stand-in for this one.
  const heartbeatAgeMs = snapshot?.workers.freshestHeartbeatAt
    ? Date.now() - new Date(snapshot.workers.freshestHeartbeatAt).getTime()
    : null;
  const heartbeatStale = snapshot
    ? isStale(heartbeatAgeMs, snapshot.workers.heartbeatMaxAgeMs)
    : false;

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Deployment evidence"
        title="Infrastructure"
        description="Read-only capacity, queue and process evidence. Missing metrics remain unknown rather than zero."
        meta={
          snapshot && (
            <StatusBadgeV2
              tone={
                snapshot.installation.status === 'ready'
                  ? 'ok'
                  : snapshot.installation.status === 'degraded'
                    ? 'warn'
                    : 'danger'
              }
              label={`Installation · ${snapshot.installation.status}`}
            />
          )
        }
        onRefresh={() => void load()}
        refreshing={loading && snapshot !== null}
      />
      <div className="ds-toolbar">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="infra-release" className="sr-only">
            Filter by release
          </label>
          <Select
            id="infra-release"
            value={releaseId}
            onChange={(value) => {
              setReleaseId(value);
              void load(value);
            }}
            placeholder="All releases"
            options={releases.map((release) => ({
              value: release.id,
              label: `${release.agentName} · ${release.id.slice(0, 8)}`,
            }))}
          />
        </div>
        <Switch checked={autoRefresh} onChange={setAutoRefresh} label="Auto-refresh every 15s" />
        {snapshot && (
          <small className="muted">Generated {formatRelativeTime(snapshot.generatedAt)}</small>
        )}
      </div>
      {error ? (
        <InlineAlert onRetry={() => void load()}>{error}</InlineAlert>
      ) : loading && !snapshot ? (
        <Skeleton shape="chart" />
      ) : snapshot ? (
        <>
          {snapshot.installation.status !== 'ready' && (
            <InlineAlert tone={snapshot.installation.status === 'degraded' ? 'warn' : 'danger'}>
              {snapshot.installation.admissionSafety}
              {snapshot.installation.reasons.length > 0 && (
                <> — {snapshot.installation.reasons.join('; ')}</>
              )}
            </InlineAlert>
          )}
          <KpiStrip>
            <KpiCard
              label="Workers busy / total"
              // `whiteSpace: nowrap`: once a sparkline shares the KPI's row, the compound value
              // had room to break between "/" and the second number ("14 /" then "24" on their
              // own lines — verifier minor #16).
              value={
                <span style={{ whiteSpace: 'nowrap' }}>
                  {snapshot.workers.busy ?? '—'} / {snapshot.workers.total ?? '—'}
                </span>
              }
              sparkline={history.map((point) => point.busy)}
            />
            <KpiCard label="Ready idle" value={snapshot.workers.ready} />
            <KpiCard
              label="Queue depth (eligible)"
              value={
                <span style={{ whiteSpace: 'nowrap' }}>
                  {snapshot.queue.depth ?? '—'} ({snapshot.queue.eligibleDepth ?? '—'})
                </span>
              }
              sparkline={history.map((point) => point.queueDepth)}
            />
            <KpiCard
              label="Oldest job age"
              value={
                snapshot.queue.oldestAgeMs != null
                  ? formatDuration(snapshot.queue.oldestAgeMs)
                  : null
              }
              footnote={stale ? <StatusBadgeV2 tone="warn" label="Stale" size="sm" /> : undefined}
            />
            <KpiCard label="Active calls" value={snapshot.telemetry?.activeCalls ?? null} />
            <KpiCard
              label="Events / 5 min"
              value={snapshot.telemetry?.eventsLastFiveMinutes ?? null}
              sparkline={history.map((point) => point.eventsPerFiveMin)}
            />
          </KpiStrip>
          <SectionCard
            title="Heartbeat freshness"
            actions={
              snapshot.workers.freshestHeartbeatAt ? (
                <StatusBadgeV2
                  tone={heartbeatStale ? 'warn' : 'ok'}
                  label={heartbeatStale ? `Stale · ${formatDuration(heartbeatAgeMs)} old` : 'Fresh'}
                />
              ) : undefined
            }
          >
            <p className="muted">
              Freshest worker heartbeat{' '}
              {snapshot.workers.freshestHeartbeatAt ? (
                <strong>{formatDateTime(snapshot.workers.freshestHeartbeatAt)}</strong>
              ) : (
                'unknown'
              )}
              , max age {formatDuration(snapshot.workers.heartbeatMaxAgeMs)}.
            </p>
          </SectionCard>
          <InfrastructureCapacityPanel snapshot={snapshot} />
          <ProviderCapacityPanel snapshot={snapshot} />
          <InfrastructureOpsPanel snapshot={snapshot} />
          {history.length > 1 && (
            <SectionCard
              title="Since you opened this page"
              description={`Last ${history.length} snapshots.`}
            >
              <div className={styles.threeColumn}>
                <p>
                  Busy workers{' '}
                  <Sparkline values={history.map((point) => point.busy)} width={120} height={32} />
                </p>
                <p>
                  Queue depth{' '}
                  <Sparkline
                    values={history.map((point) => point.queueDepth)}
                    width={120}
                    height={32}
                  />
                </p>
                <p>
                  Events / 5 min{' '}
                  <Sparkline
                    values={history.map((point) => point.eventsPerFiveMin)}
                    width={120}
                    height={32}
                  />
                </p>
              </div>
            </SectionCard>
          )}
        </>
      ) : null}
    </div>
  );
}
