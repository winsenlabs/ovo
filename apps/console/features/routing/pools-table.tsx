'use client';
import { ProgressMeter } from '../../components/charts/meter';
import { DataTableV2, type ColumnV2 } from '../../components/ui/data-table-v2';
import { EmptyStateV2 } from '../../components/ui/feedback-v2';
import { loadLabel, poolFacts } from '../../lib/derive/routing-pools';
import { poolUsers } from '../../lib/derive/routing-overview';
import type { PointRecord, PoolRecord, PoolUtilisation } from '../../lib/types/routing';

export function PoolsTable({
  pools,
  points,
  utilisation,
  loading,
  error,
  onRetry,
  create,
}: {
  pools: readonly PoolRecord[];
  points: readonly PointRecord[];
  utilisation: ReadonlyMap<string, PoolUtilisation>;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  create?: React.ReactNode;
}) {
  const columns: ColumnV2<PoolRecord>[] = [
    { id: 'name', header: 'Name', cell: (p) => <strong>{p.definition.name}</strong>, sortValue: (p) => p.definition.name },
    {
      id: 'members',
      header: 'Members',
      align: 'end',
      cell: (p) => {
        const facts = poolFacts(p.definition);
        return `${facts.enabled}/${facts.members}`;
      },
    },
    { id: 'languages', header: 'Languages', priority: 'low', cell: (p) => poolFacts(p.definition).languages.join(', ') },
    {
      id: 'load',
      header: 'Active calls',
      cell: (p) => {
        const util = utilisation.get(p.id);
        if (!util) return <span className="muted">Not available</span>;
        const { active, capacity } = util.total;
        return capacity ? (
          <ProgressMeter label={`${p.definition.name} load`} value={active} max={capacity} valueLabel={loadLabel(active, capacity)} />
        ) : (
          loadLabel(active, null)
        );
      },
    },
    {
      id: 'usedBy',
      header: 'Used by',
      priority: 'low',
      cell: (p) => {
        const users = poolUsers(points, p.id);
        return users.length ? users.map((u) => u.name).join(', ') : <span className="muted">Nothing yet</span>;
      },
    },
  ];
  return (
    <DataTableV2
      label="Agent pools"
      rows={pools}
      columns={columns}
      rowKey={(p) => p.id}
      rowHref={(p) => `/routing/pools/${p.id}`}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={
        <EmptyStateV2 title="No pools yet" action={create}>
          A pool is a group of agents a routing point picks from, by language, product and skill.
        </EmptyStateV2>
      }
    />
  );
}
