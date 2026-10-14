'use client';
import type { LineSeries } from '../charts/line-chart';
import { LineChart } from '../charts/line-chart';
import { ChartFrame } from '../charts/chart-frame';
import { SectionCard } from '../ui/section-card';
import { formatRelativeTime } from '../../lib/format';

function flat(series: readonly LineSeries[], index: number) {
  const points = series.flatMap((item) =>
    item.points.map((point) => ({ label: item.label, point })),
  );
  return points[index];
}

/** Pass-rate trend per dataset, extracted from `EvaluationRunsPanel` to keep that module under
 * the size gate. */
export function EvaluationPassRateChart({ trend }: { trend: readonly LineSeries[] }) {
  return (
    <SectionCard
      title="Pass-rate trend"
      description="Finished runs' pass rate per dataset, failed runs marked."
    >
      <ChartFrame
        ariaLabel="Pass-rate trend per dataset"
        empty={trend.length === 0}
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
    </SectionCard>
  );
}
