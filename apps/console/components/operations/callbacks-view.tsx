'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import { dueBucket, groupByDueBucket } from '../../lib/derive/operations';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { DataTableV2 } from '../ui/data-table-v2';
import { EmptyStateV2, ErrorState } from '../ui/feedback-v2';
import { callbackColumns } from './callbacks-view-columns';

export interface CallbackRecord {
  id: string;
  callId: string;
  dueAt: string;
  timezone: string;
  source: 'flow' | 'llm';
  node: string | null;
  disposition: string | null;
  reason: string | null;
  status: 'pending' | 'dialing' | 'dialed' | 'completed' | 'cancelled';
  dialedCallId: string | null;
  phone: string | null;
}

interface CallbackPage {
  available: boolean;
  items: CallbackRecord[];
  nextCursor: string | null;
}

const STATUSES = ['pending', 'dialing', 'dialed', 'completed', 'cancelled', 'all'] as const;
type Filter = (typeof STATUSES)[number];

/**
 * Callbacks agents promised on calls (AGT-15), grouped by when they are due, soonest and most
 * overdue first. Dialling one places a live call to the same number with the same release and
 * its variables; a callback handled another way is marked completed, and one no longer wanted is
 * cancelled.
 */
export function CallbacksView({
  role,
  now = () => new Date(),
}: {
  role: SessionIdentity['role'];
  now?: () => Date;
}) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [page, setPage] = useState<CallbackPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const query = filter === 'all' ? '' : `?status=${filter}`;
      setPage((await apiRequest<CallbackPage>(`/callbacks${query}`)).data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Callbacks could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(record: CallbackRecord, action: 'dial' | 'complete' | 'cancel') {
    setBusy(record.id);
    setError(undefined);
    try {
      await apiRequest(`/callbacks/${record.id}/${action}`, { method: 'POST', body: '{}' });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Callback could not ${action}.`);
    } finally {
      setBusy(undefined);
    }
  }

  const admin = role === 'admin';
  const items = page?.items ?? [];
  const overdueCount = useMemo(
    () => items.filter((row) => dueBucket(row.dueAt, row.status, now()) === 'overdue').length,
    [items, now],
  );
  const dialingCount = items.filter((row) => row.status === 'dialing').length;
  const completedTodayCount = items.filter((row) => {
    if (row.status !== 'completed') return false;
    const day = (value: Date) => value.toDateString();
    return day(new Date(row.dueAt)) === day(now());
  }).length;

  const columns = useMemo(
    () => callbackColumns({ admin, busy, now, act: (record, action) => void act(record, action) }),
    [admin, busy, now],
  );
  const groups = useMemo(
    () => groupByDueBucket(items, (row) => dueBucket(row.dueAt, row.status, now())),
    [items, now],
  );

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Callbacks"
        description="Callbacks the agent promised on a call. Dialling one places a live call to the same number with the same release, subject to the live-call checks."
        onRefresh={() => void load()}
        refreshing={loading}
      />
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {page && !page.available ? (
        <EmptyStateV2 variant="unavailable" title="Callbacks need PostgreSQL storage">
          This installation keeps no durable call outcomes, so no callback is recorded.
        </EmptyStateV2>
      ) : (
        <>
          <KpiStrip>
            <KpiCard label="Shown" value={loading ? undefined : items.length} loading={loading} />
            <KpiCard
              label="Overdue"
              value={loading ? undefined : overdueCount}
              loading={loading}
              footnote="Still pending, past due"
            />
            {filter === 'all' && (
              <>
                <KpiCard label="Dialing" value={dialingCount} />
                <KpiCard label="Completed today" value={completedTodayCount} />
              </>
            )}
          </KpiStrip>
          <div className="ds-range-picker" role="group" aria-label="Callback status">
            {STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                aria-pressed={filter === status}
                className={filter === status ? 'selected' : ''}
                onClick={() => setFilter(status)}
              >
                {status[0]!.toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>
          {loading ? (
            <DataTableV2
              label="Callbacks"
              rows={[]}
              columns={columns}
              rowKey={(record) => record.id}
              loading
            />
          ) : !items.length ? (
            <EmptyStateV2 variant="filtered" title="No callbacks">
              No callback matches this filter.
            </EmptyStateV2>
          ) : (
            groups.map((group) => (
              <SectionCard key={group.bucket} title={group.label} padding="flush">
                <DataTableV2
                  label={`Callbacks due ${group.label.toLowerCase()}`}
                  rows={group.rows}
                  columns={columns}
                  rowKey={(record) => record.id}
                />
              </SectionCard>
            ))
          )}
        </>
      )}
    </>
  );
}
