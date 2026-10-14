'use client';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { ChartFrame } from '../../../components/charts/chart-frame';
import { BarChart } from '../../../components/charts/bar-chart';
import { Duration, Percent } from '../../../components/ui/display';
import { humaniseEnum } from '../../../lib/status';
import {
  CALL_STATUS_KEYS,
  type CallsKpis,
  type CallsOverTime,
  type EndReasonCount,
} from '../../../lib/derive/calls';

// The brief's status tone map, not `BarChart`'s default series-index palette: "Failed" reads as
// `--danger` everywhere else on this page (the status badge, the end-reasons bar), so the volume
// chart uses the same tokens instead of an arbitrary palette colour for the same status.
const STATUS_SERIES_COLOR: Record<string, string> = {
  completed: 'var(--ok)',
  in_progress: 'var(--info)',
  failed: 'var(--danger)',
  cancelled: 'var(--neutral)',
};

/** The Calls list's KPI strip + primary visual: calls-over-time stacked by status, and the top
 * end reasons, both over the loaded window (brief §3 CALLS). */
export function CallsOverview({
  kpis,
  overTime,
  endReasons,
  loading,
  error,
  onRetry,
}: {
  kpis: CallsKpis;
  overTime: CallsOverTime;
  endReasons: EndReasonCount[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <>
      <KpiStrip>
        <KpiCard label="Calls (window)" value={kpis.total} loading={loading} />
        <KpiCard
          label="Completion rate"
          value={kpis.completionRate != null ? <Percent value={kpis.completionRate} /> : null}
          footnote={`${kpis.completed} of ${kpis.total - kpis.liveNow} finished`}
          loading={loading}
        />
        <KpiCard
          label="Failed"
          value={kpis.failed}
          footnote={
            kpis.failedTimeoutShare != null ? (
              <Percent value={kpis.failedTimeoutShare} digits={0} />
            ) : undefined
          }
          loading={loading}
        />
        <KpiCard
          label="Median duration"
          value={kpis.medianDurationMs != null ? <Duration ms={kpis.medianDurationMs} /> : null}
          loading={loading}
        />
        <KpiCard label="Live now" value={kpis.liveNow} loading={loading} />
      </KpiStrip>
      <div className="ui-grid">
        <ChartFrame
          title="Calls over time"
          ariaLabel={`Calls over time, by ${overTime.granularity}`}
          loading={loading}
          error={error}
          onRetry={onRetry}
          empty={!overTime.points.length}
          tableRows={overTime.points.length}
          tableColumns={[
            { header: 'Period', cell: (i) => overTime.points[i]!.category },
            ...CALL_STATUS_KEYS.map((key) => ({
              header: humaniseEnum(key),
              cell: (i: number) => overTime.points[i]!.values[key] ?? 0,
            })),
          ]}
          renderChart={(width) => (
            <BarChart
              width={width}
              data={overTime.points}
              seriesKeys={[...CALL_STATUS_KEYS]}
              mode="stacked"
              seriesLabel={humaniseEnum}
              seriesColor={(key) => STATUS_SERIES_COLOR[key] ?? 'var(--neutral)'}
            />
          )}
        />
        <ChartFrame
          title="Top end reasons"
          ariaLabel="Top end reasons in this window"
          loading={loading}
          error={error}
          onRetry={onRetry}
          empty={!endReasons.length}
          height={Math.max(140, endReasons.length * 32)}
          tableRows={endReasons.length}
          tableColumns={[
            { header: 'End reason', cell: (i) => endReasons[i]!.label },
            { header: 'Calls', cell: (i) => endReasons[i]!.count },
          ]}
          renderChart={(width) => (
            <BarChart
              width={width}
              height={Math.max(140, endReasons.length * 32)}
              orientation="horizontal"
              data={endReasons.map((reason) => ({
                category: reason.label,
                values: { count: reason.count },
              }))}
              seriesKeys={['count']}
            />
          )}
        />
      </div>
    </>
  );
}
