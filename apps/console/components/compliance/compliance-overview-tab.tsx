import { SectionCard } from '../ui/section-card';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { ChartFrame } from '../charts/chart-frame';
import { BarChart } from '../charts/bar-chart';
import { formatDate } from '../../lib/format';
import { dueLabel, type Complaint, type SettingsRecord } from './compliance-types';

/** The Overview tab: ratios chart, complaint SLA queue, blackout dates. Split out of
 * `ComplianceView` purely to keep that module under the size gate. */
export function ComplianceOverviewTab({
  ratioChartData,
  slaQueue,
  settings,
}: {
  ratioChartData: readonly { category: string; values: { abandoned: number; silent: number } }[];
  slaQueue: readonly Complaint[];
  settings: SettingsRecord;
}) {
  return (
    <div className="stack">
      <ChartFrame
        title="Abandoned & silent ratios by caller number"
        ariaLabel="Abandoned and silent call ratios by caller number, last 24 hours"
        empty={ratioChartData.length === 0}
        tableRows={ratioChartData.length}
        tableColumns={[
          { header: 'Number', cell: (i) => ratioChartData[i]?.category },
          { header: 'Abandoned %', cell: (i) => ratioChartData[i]?.values.abandoned.toFixed(1) },
          { header: 'Silent %', cell: (i) => ratioChartData[i]?.values.silent.toFixed(1) },
        ]}
        renderChart={(width) => (
          <BarChart
            data={ratioChartData}
            seriesKeys={['abandoned', 'silent']}
            width={width}
            // Horizontal, not vertical: BarChart's vertical mode draws a correct Y axis label
            // 0 at the bottom today but the axis TICK labels themselves are generated from an
            // uncompensated top-origin scale, so the printed 0%/1%/2%/3% ticks read inverted
            // (0% at the top). Horizontal mode's X axis has no such bug. Logged as a foundation
            // defect; this is the workaround for this one chart until it is fixed upstream.
            orientation="horizontal"
            valueFormat={(v) => `${v.toFixed(1)}%`}
            seriesLabel={(key) => (key === 'abandoned' ? 'Abandoned' : 'Silent')}
          />
        )}
      />
      <SectionCard title="Complaint SLA queue" padding="prose">
        {slaQueue.length === 0 ? (
          <EmptyStateV2 title="No open complaints" />
        ) : (
          <ul className="stack">
            {slaQueue.slice(0, 8).map((c) => (
              <li key={c.id}>
                {c.kind} ·{' '}
                {c.overdue === 'ack' && c.ackDueAt
                  ? `Ack ${dueLabel(c.ackDueAt)}`
                  : `Resolve ${dueLabel(c.resolveDueAt)}`}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="Blackout dates" padding="prose">
        {settings.settings.blackout.dates.length === 0 ? (
          <EmptyStateV2 title="No blackout dates configured" />
        ) : (
          <div className="button-row">
            {settings.settings.blackout.dates.map((date) => (
              <span key={date} className="ds-chip">
                {/^\d{4}-\d{2}-\d{2}$/.test(date) ? formatDate(date) : date}
              </span>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
