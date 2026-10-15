'use client';
import type { LineSeries } from '../charts/line-chart';
import { LineChart } from '../charts/line-chart';
import { ChartFrame } from '../charts/chart-frame';
import { SectionCard } from '../ui/section-card';
import { CHART_PALETTE } from '../charts/scale';
import { StatusBadgeV2 } from '../ui/status-badge';
import { formatRelativeTime } from '../../lib/format';
import type { FailedRunPoint } from '../../lib/derive/evaluations';

function flat(series: readonly LineSeries[], index: number) {
  const points = series.flatMap((item) =>
    item.points.map((point) => ({ label: item.label, point })),
  );
  return points[index];
}

/** Pass-rate trend per dataset, extracted from `EvaluationRunsPanel` to keep that module under
 * the size gate. Failed runs arrive separately (`failures`): they never sat on the continuous
 * line, so they're surfaced here as their own callouts instead of silently missing (verifier
 * major #6). */
export function EvaluationPassRateChart({
  trend,
  failures = [],
}: {
  trend: readonly LineSeries[];
  failures?: readonly FailedRunPoint[];
}) {
  return (
    <SectionCard
      title="Pass-rate trend"
      description="Succeeded runs' pass rate per dataset. Failed runs are called out below, not plotted as a 0% dip."
    >
      {trend.length > 0 && (
        <ul className="ds-chart-legend" style={{ marginBottom: 'var(--space-2)' }}>
          {trend.map((item, index) => (
            <li key={item.key}>
              <span
                className="ds-legend-swatch"
                style={{ background: CHART_PALETTE[index % CHART_PALETTE.length] }}
              />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      <ChartFrame
        ariaLabel="Pass-rate trend per dataset"
        empty={trend.length === 0 && failures.length === 0}
        emptyLabel="No finished runs yet"
        tableRows={trend.flatMap((series) => series.points).length}
        tableColumns={[
          { header: 'Dataset', cell: (i) => flat(trend, i)?.label },
          { header: 'At', cell: (i) => formatRelativeTime(flat(trend, i)?.point.x) },
          {
            header: 'Pass rate',
            cell: (i) => `${Math.round((flat(trend, i)?.point.y ?? 0) * 100)}%`,
          },
        ]}
        renderChart={(width) => (
          <LineChart
            series={trend}
            width={width}
            xScale="time"
            yMax={1}
            xFormat={(value) =>
              new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            }
            yFormat={(value) => `${Math.round(value * 100)}%`}
          />
        )}
      />
      {failures.length > 0 && (
        <div className="ui-cluster" style={{ marginTop: 'var(--space-3)' }}>
          {failures.slice(0, 8).map((failure) => (
            <StatusBadgeV2
              key={failure.runId}
              tone="danger"
              label={`${failure.datasetName} failed · ${formatRelativeTime(failure.at)}`}
              size="sm"
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
