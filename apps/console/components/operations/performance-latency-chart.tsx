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
  const visibleSeries = series.filter((item) => !hiddenStages.has(item.key));
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
        legend={
          <ul className="ds-chart-legend">
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
        }
        renderChart={(width) => (
          <LineChart
            series={visibleSeries}
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
