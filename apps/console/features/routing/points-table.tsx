'use client';
import { DataTableV2, type ColumnV2 } from '../../components/ui/data-table-v2';
import { EmptyStateV2 } from '../../components/ui/feedback-v2';
import { StatusBadgeV2 } from '../../components/ui/status-badge';
import { formatRelativeTime } from '../../lib/format';
import { pointIssueCounts, pointStates } from '../../lib/derive/routing-overview';
import type { PointRecord } from '../../lib/types/routing';

const columns: ColumnV2<PointRecord>[] = [
  { id: 'name', header: 'Name', cell: (p) => <strong>{p.draft.name}</strong>, sortValue: (p) => p.draft.name },
  {
    id: 'state',
    header: 'State',
    cell: (p) => (
      <span className="rt-badges">
        {pointStates(p).map((s) => (
          <StatusBadgeV2 key={s.label} tone={s.tone} label={s.label} size="sm" />
        ))}
      </span>
    ),
  },
  { id: 'nodes', header: 'Questions', align: 'end', priority: 'low', cell: (p) => p.summary?.nodes ?? p.draft.nodes.length },
  { id: 'pools', header: 'Pools', align: 'end', priority: 'low', cell: (p) => p.summary?.pools ?? '—' },
  {
    id: 'issues',
    header: 'Issues',
    cell: (p) => {
      const { errors, warnings } = pointIssueCounts(p);
      return errors || warnings ? (
        <span className="rt-badges">
          {errors > 0 && <StatusBadgeV2 tone="danger" label={`${errors} error${errors === 1 ? '' : 's'}`} size="sm" />}
          {warnings > 0 && <StatusBadgeV2 tone="warn" label={`${warnings} warning${warnings === 1 ? '' : 's'}`} size="sm" />}
        </span>
      ) : (
        <StatusBadgeV2 tone="ok" label="None" size="sm" />
      );
    },
  },
  { id: 'numbers', header: 'Numbers', align: 'end', priority: 'low', cell: (p) => p.summary?.numbers ?? '—' },
  {
    id: 'updated',
    header: 'Updated',
    priority: 'low',
    cell: (p) => formatRelativeTime(p.updatedAt),
    sortValue: (p) => p.updatedAt,
  },
];

export function PointsTable({
  points,
  loading,
  error,
  onRetry,
  create,
}: {
  points: readonly PointRecord[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  create?: React.ReactNode;
}) {
  return (
    <DataTableV2
      label="Routing points"
      rows={points}
      columns={columns}
      rowKey={(p) => p.id}
      rowHref={(p) => `/routing/points/${p.id}`}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={
        <EmptyStateV2 title="No routing points yet" action={create}>
          A routing point greets callers, works out the language and the reason for the call, and hands
          the call to the right agent or person.
        </EmptyStateV2>
      }
    />
  );
}
