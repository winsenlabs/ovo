'use client';
import type { PerformanceGroupResult } from '@winsendotai/ovo-contracts';
import type { LineSeries } from '../charts/line-chart';
import { LineChart } from '../charts/line-chart';
import { ChartFrame } from '../charts/chart-frame';
import { SectionCard } from '../ui/section-card';
import { CHART_PALETTE, formatMsAxis } from '../charts/scale';
import { humaniseEnum } from '../../lib/status';
import type { Percentile } from '../../lib/derive/performance';

const PERCENTILES: { id: Percentile; label: string }[] = [
  { id: 'p50Ms', label: 'p50' },
  { id: 'p95Ms', label: 'p95' },
  { id: 'p99Ms', label: 'p99' },
];

/** The primary visual: one line per stage, a p50/p95/p99 toggle, and a legend that hides a stage
 * series on click. Extracted from `PerformanceView` to keep that module under the size gate. */
export function PerformanceLatencyChart({
  groups,
  series,
  hiddenStages,
  onToggleStage,
  percentile,
  onPercentileChange,
  loading,
}: {
  groups: readonly PerformanceGroupResult[];
  series: readonly LineSeries[];
  hiddenStages: ReadonlySet<string>;
  onToggleStage: (key: string) => void;
  percentile: Percentile;
  onPercentileChange: (percentile: Percentile) => void;
  loading: boolean;
}) {
  // Keep every stage at its original index and just empty out a hidden one's points, rather than
  // filtering it out of the array: `LineChart` colours each series by its position in the array
  // it receives, and the legend below colours by position in the *full* `series` list. Filtering
  // let those two indices drift apart the moment any stage but the last was hidden, so every
  // remaining line silently took on the next stage's colour (verifier major #1).
  const chartSeries = series.map((item) =>
    hiddenStages.has(item.key) ? { ...item, points: [], band: undefined } : item,
  );
  return (
    <SectionCard
      title="Latency over time"
      description="One line per stage. Click a stage in the legend to hide it."
      actions={
        <div className="ds-chart-toggle" role="radiogroup" aria-label="Percentile">
          {PERCENTILES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={percentile === item.id}
              className={percentile === item.id ? 'selected' : ''}
              onClick={() => onPercentileChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      }
    >
      {/* Rendered above `ChartFrame` instead of passed as its `legend` (inside the frame's own
          header, next to the Chart/Table toggle): a 7-item legend there has nowhere to go at
          390px and clips the Table button (verifier major #4). Its own row can wrap freely. */}
      <ul className="ds-chart-legend" style={{ marginBottom: 'var(--space-2)' }}>
        {series.map((item, index) => (
          <li key={item.key}>
            <button
              type="button"
              className="text-button"
              aria-pressed={!hiddenStages.has(item.key)}
              onClick={() => onToggleStage(item.key)}
              style={{ opacity: hiddenStages.has(item.key) ? 0.4 : 1 }}
            >
              <span
                className="ds-legend-swatch"
                style={{ background: CHART_PALETTE[index % CHART_PALETTE.length] }}
              />
              {item.label}
            </button>
          </li>
        ))}
      </ul>
      <ChartFrame
        ariaLabel={`${percentile} latency over time by stage`}
        loading={loading}
        empty={!loading && series.length === 0}
        emptyLabel="No telemetry matched this range or filters"
        height={260}
        tableRows={groups.length}
        tableColumns={[
          {
            header: 'Stage',
            cell: (i) => (groups[i]?.cohort.stage ? humaniseEnum(groups[i].cohort.stage!) : '—'),
          },
          { header: 'Time', cell: (i) => groups[i]?.cohort.time },
          {
            header: percentile,
            cell: (i) =>
              groups[i]?.[percentile] != null ? formatMsAxis(groups[i][percentile]!) : '—',
          },
        ]}
        renderChart={(width) => (
          <LineChart
            series={chartSeries}
            width={width}
            height={260}
            xScale="time"
            xFormat={(value) =>
              new Date(value).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit' })
            }
            yFormat={formatMsAxis}
          />
        )}
      />
    </SectionCard>
  );
}
