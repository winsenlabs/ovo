'use client';
import { useEffect, useState } from 'react';
import { Select } from '../../components/ui/inputs';
import { DataTableV2, type ColumnV2 } from '../../components/ui/data-table-v2';
import { Drawer } from '../../components/ui/drawer';
import { EmptyStateV2, ErrorState } from '../../components/ui/feedback-v2';
import { KpiCard, KpiStrip } from '../../components/ui/kpi';
import { StatusBadgeV2 } from '../../components/ui/status-badge';
import { ApiError } from '../../lib/api';
import { queuesApi } from '../../lib/data/queues-api';
import { formatDateTime, formatDuration } from '../../lib/format';
import type { ActivityWindow, QueueActivity, QueueRecord } from '../../lib/types/queues';

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: QueueActivity }
  | { status: 'disabled' }
  | { status: 'error'; message: string };
type Ticket = QueueActivity['tickets'][number];

const columns: ColumnV2<Ticket>[] = [
  { id: 'created', header: 'Started', cell: (t) => formatDateTime(t.createdAt) },
  {
    id: 'ticket',
    header: 'Ticket',
    priority: 'low',
    cell: (t) => <span className="mono">{t.id}</span>,
  },
  {
    id: 'call',
    header: 'Call',
    cell: (t) => <a href={`/calls/${encodeURIComponent(t.callId)}`}>{t.callId.slice(0, 13)}</a>,
  },
  { id: 'wait', header: 'Waited', align: 'end', cell: (t) => formatDuration(t.waitMs) },
  { id: 'status', header: 'State', cell: (t) => <StatusBadgeV2 value={t.status} size="sm" /> },
  {
    id: 'outcome',
    header: 'Outcome',
    priority: 'low',
    cell: (t) => t.outcome ?? t.releaseCode ?? '—',
  },
];

/**
 * What happened in a queue lately: counts and waits for 24 hours or 7 days, and the newest
 * tickets as ids and codes. It never shows a caller number, a summary or any call context.
 */
export function ActivityDrawer({
  record,
  onClose,
}: {
  record: QueueRecord | undefined;
  onClose: () => void;
}) {
  const [window, setWindow] = useState<ActivityWindow>('24h');
  const [state, setState] = useState<State>({ status: 'loading' });
  const id = record?.id;
  useEffect(() => {
    if (!id) return;
    let live = true;
    setState({ status: 'loading' });
    void queuesApi.activity(id, window).then(
      (data) => live && setState({ status: 'ready', data }),
      (failure) =>
        live &&
        setState(
          failure instanceof ApiError && failure.code === 'human_queue_disabled'
            ? { status: 'disabled' }
            : {
                status: 'error',
                message:
                  failure instanceof Error ? failure.message : 'Activity could not be loaded.',
              },
        ),
    );
    return () => {
      live = false;
    };
  }, [id, window]);
  const data = state.status === 'ready' ? state.data : undefined;
  const loading = state.status === 'loading';
  return (
    <Drawer
      open={record !== undefined}
      title={`Activity: ${record?.definition.name ?? ''}`}
      onClose={onClose}
    >
      <div className="rt-stack">
        <Select
          aria-label="Period"
          value={window}
          options={[
            { value: '24h', label: 'Last 24 hours' },
            { value: '7d', label: 'Last 7 days' },
          ]}
          onChange={(v) => setWindow(v as ActivityWindow)}
        />
        {state.status === 'error' && (
          <ErrorState message={state.message} onRetry={() => setWindow((w) => w)} />
        )}
        {state.status === 'disabled' && (
          <EmptyStateV2 variant="unavailable" title="Human queues are not enabled here" />
        )}
        {state.status !== 'error' && state.status !== 'disabled' && (
          <>
            <KpiStrip>
              <KpiCard label="Callers" value={data?.stats.created} loading={loading} />
              <KpiCard label="Handled" value={data?.stats.handled} loading={loading} />
              <KpiCard
                label="Gave up"
                value={data ? data.stats.abandoned + data.stats.expired : undefined}
                loading={loading}
              />
              <KpiCard
                label="Average wait"
                value={data?.stats.avgWaitMs == null ? null : formatDuration(data.stats.avgWaitMs)}
                loading={loading}
                footnote={
                  data?.stats.p95WaitMs == null
                    ? undefined
                    : `p95 ${formatDuration(data.stats.p95WaitMs)}`
                }
              />
            </KpiStrip>
            {data && Object.keys(data.stats.byOutcome).length > 0 && (
              <p className="rt-badges">
                {Object.entries(data.stats.byOutcome).map(([outcome, n]) => (
                  <span key={outcome} className="ds-chip">
                    {outcome.replaceAll('_', ' ')} {n}
                  </span>
                ))}
              </p>
            )}
            <DataTableV2
              label="Recent tickets"
              rows={data?.tickets ?? []}
              columns={columns}
              rowKey={(t) => t.id}
              loading={loading}
              density="compact"
              empty={<EmptyStateV2 title="No callers in this period" />}
            />
          </>
        )}
      </div>
    </Drawer>
  );
}
