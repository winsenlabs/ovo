'use client';
import { useState } from 'react';
import type { PerformanceGroupResult } from '@winsendotai/ovo-contracts';
import { humaniseEnum } from '../../lib/status';
import { formatDateTime, shortenId } from '../../lib/format';
import { formatMsAxis } from '../charts/scale';
import { stageBreakdownBars } from '../../lib/derive/performance';
import { SectionCard } from '../ui/section-card';
import { ChartFrame } from '../charts/chart-frame';
import { BarChart } from '../charts/bar-chart';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { Button } from '../ui/button';

const cohortLabel = (group: PerformanceGroupResult): string => {
  const { cohort } = group;
  const parts = [
    cohort.stage && humaniseEnum(cohort.stage),
    cohort.time && formatDateTime(cohort.time),
    cohort.agent,
    cohort.provider,
  ].filter(Boolean);
  return parts.join(' · ') || 'Cohort';
};

/**
 * Stage breakdown (p50/p95 across the whole range) plus the raw cohort rows, with evidence calls
 * now linking to `/calls/:id` instead of the bare `/calls` list (brief defect #13), and labels
 * humanised instead of raw ISO strings and camelCase keys.
 */
export function PerformanceDetailTable({
  stageGroups,
  cohortGroups,
  loading,
  error,
  onRetry,
}: {
  stageGroups: readonly PerformanceGroupResult[];
  cohortGroups: readonly PerformanceGroupResult[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const bars = stageBreakdownBars(stageGroups);
  const rows = [...cohortGroups].sort((a, b) =>
    (b.cohort.time ?? '').localeCompare(a.cohort.time ?? ''),
  );

  const columns: ColumnV2<PerformanceGroupResult>[] = [
    { id: 'cohort', header: 'Cohort', cell: cohortLabel },
    {
      id: 'calls',
      header: 'Calls / samples',
      cell: (group) => `${group.callCount} / ${group.sampleCount}`,
      sortValue: (group) => group.sampleCount,
      align: 'end',
    },
    {
      id: 'issues',
      header: 'Errors / timeouts',
      cell: (group) => `${group.errors} / ${group.timeouts}`,
      align: 'end',
    },
    {
      id: 'p50',
      header: 'p50',
      cell: (group) => (group.p50Ms == null ? '—' : formatMsAxis(group.p50Ms)),
      sortValue: (group) => group.p50Ms ?? -1,
      align: 'end',
    },
    {
      id: 'p95',
      header: 'p95',
      cell: (group) => (group.p95Ms == null ? '—' : formatMsAxis(group.p95Ms)),
      sortValue: (group) => group.p95Ms ?? -1,
      align: 'end',
    },
    {
      id: 'p99',
      header: 'p99',
      cell: (group) => (group.p99Ms == null ? '—' : formatMsAxis(group.p99Ms)),
      sortValue: (group) => group.p99Ms ?? -1,
      align: 'end',
    },
    {
      id: 'evidence',
      header: 'Evidence calls',
      cell: (group) =>
        group.callIds.length ? (
          <span className="ds-choice-chips">
            {group.callIds.slice(0, 3).map((id) => (
              <a key={id} className="mono" href={`/calls/${id}`}>
                {shortenId(id)}
              </a>
            ))}
          </span>
        ) : (
          '—'
        ),
      priority: 'low',
    },
  ];

  return (
    <div className="ds-stack">
      <SectionCard
        title="Stage breakdown"
        description="p50 and p95 per stage across the whole range."
      >
        <ChartFrame
          ariaLabel="Latency p50 and p95 by stage"
          loading={loading}
          error={error}
          onRetry={onRetry}
          empty={!loading && bars.length === 0}
          tableRows={bars.length}
          tableColumns={[
            { header: 'Stage', cell: (i) => bars[i]?.category },
            { header: 'p50', cell: (i) => formatMsAxis(bars[i]?.values.p50 ?? 0) },
            { header: 'p95', cell: (i) => formatMsAxis(bars[i]?.values.p95 ?? 0) },
          ]}
          renderChart={(width) => (
            <BarChart
              data={bars}
              seriesKeys={['p50', 'p95']}
              width={width}
              orientation="horizontal"
              valueFormat={formatMsAxis}
              seriesLabel={(key) => key.toUpperCase()}
            />
          )}
        />
      </SectionCard>
      <SectionCard
        title="Cohort detail"
        description={`${rows.length} cohort${rows.length === 1 ? '' : 's'} in range.`}
        padding={open ? 'flush' : 'data'}
        actions={
          <Button type="button" onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide table' : 'Show table'}
          </Button>
        }
      >
        {open && (
          <DataTableV2
            // See price-catalog-panel.tsx: remounts across the loading/empty → loaded boundary to
            // avoid DataTableV2's hook-count mismatch (foundation request in the build report).
            key={loading ? 'loading' : rows.length > 0 ? 'loaded' : 'empty'}
            label="Performance cohort detail"
            rows={rows}
            loading={loading}
            error={error}
            onRetry={onRetry}
            columns={columns}
            rowKey={(group) => JSON.stringify(group.cohort)}
            empty="No telemetry matched this range or filters."
          />
        )}
      </SectionCard>
    </div>
  );
}
