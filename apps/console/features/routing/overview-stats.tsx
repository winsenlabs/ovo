'use client';
import { BarChart } from '../../components/charts/bar-chart';
import { ChartFrame } from '../../components/charts/chart-frame';
import { Select } from '../../components/ui/inputs';
import { KpiCard, KpiStrip } from '../../components/ui/kpi';
import { SectionCard } from '../../components/ui/section-card';
import type { Load } from '../../lib/data/use-routing-load';
import {
  seriesData,
  statsKpis,
  TARGET_SERIES,
  TARGET_SERIES_LABEL,
} from '../../lib/derive/routing-overview';
import { formatDuration } from '../../lib/format';
import { ROUTING_STATS_WINDOWS, type RoutingStats, type StatsWindow } from '../../lib/types/routing';

const WINDOW_LABEL: Record<StatsWindow, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };

/** KPIs and the routed-calls chart; unknown (a dash) when call outcomes are not stored here. */
export function OverviewStats({
  load,
  window,
  onWindow,
  onRetry,
}: {
  load: Load<RoutingStats>;
  window: StatsWindow;
  onWindow: (value: StatsWindow) => void;
  onRetry: () => void;
}) {
  const stats = load.status === 'ready' ? load.data : undefined;
  const loading = load.status === 'loading';
  const kpi = statsKpis(stats);
  const data = seriesData(stats);
  const unknownNote = stats?.available === false ? 'Call outcomes are not stored here' : undefined;
  const totalOf = (row: number) => TARGET_SERIES.reduce((sum, k) => sum + (data[row]?.values[k] ?? 0), 0);
  return (
    <>
      <KpiStrip>
        <KpiCard label="Routed calls" value={kpi.routed} loading={loading} footnote={unknownNote} />
        <KpiCard
          label="Fallback rate"
          value={kpi.fallbackRate == null ? null : `${kpi.fallbackRate}%`}
          loading={loading}
          footnote="Calls that needed a fallback step"
        />
        <KpiCard label="Reached a person" value={kpi.reachedPerson} loading={loading} />
        <KpiCard
          label="Median route time"
          value={kpi.p50 == null ? null : formatDuration(kpi.p50)}
          loading={loading}
          footnote={kpi.p95 == null ? undefined : `p95 ${formatDuration(kpi.p95)}`}
        />
      </KpiStrip>
      <SectionCard
        title="Routed calls"
        description="Where callers ended up, by target."
        actions={
          <Select
            aria-label="Range"
            value={window}
            options={ROUTING_STATS_WINDOWS.map((w) => ({ value: w, label: WINDOW_LABEL[w] }))}
            onChange={(next) => onWindow(next as StatsWindow)}
          />
        }
      >
        <ChartFrame
          ariaLabel="Routed calls by target over time"
          height={220}
          loading={loading}
          error={load.status === 'error' ? load.message : undefined}
          onRetry={onRetry}
          empty={!loading && load.status !== 'error' && data.length === 0}
          emptyLabel={unknownNote ?? 'No routed calls in this range'}
          tableRows={data.length}
          tableColumns={[
            { header: 'Time', cell: (row) => data[row]?.category },
            ...TARGET_SERIES.map((key) => ({
              header: TARGET_SERIES_LABEL[key],
              cell: (row: number) => data[row]?.values[key] ?? 0,
            })),
            { header: 'Total', cell: totalOf },
          ]}
          renderChart={(width) => (
            <BarChart
              data={data}
              seriesKeys={TARGET_SERIES}
              width={width}
              mode="stacked"
              seriesLabel={(key) => TARGET_SERIES_LABEL[key as keyof typeof TARGET_SERIES_LABEL]}
            />
          )}
        />
      </SectionCard>
    </>
  );
}
