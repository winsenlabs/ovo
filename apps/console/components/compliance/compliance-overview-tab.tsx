import { SectionCard } from '../ui/section-card';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { ChartFrame } from '../charts/chart-frame';
import { BarChart } from '../charts/bar-chart';
import { ProgressMeter } from '../charts/meter';
import { formatDate, formatPercent } from '../../lib/format';
import {
  complaintKindLabel,
  dueLabel,
  type CliRatio,
  type Complaint,
  type SettingsRecord,
} from './compliance-types';

const BREAKER_PERCENT = 3;
const METER_TONE: Record<CliRatio['level'], 'ok' | 'warn' | 'danger'> = {
  ok: 'ok',
  warn: 'warn',
  stop: 'danger',
};

/** The Overview tab: ratios chart, complaint SLA queue, blackout dates. Split out of
 * `ComplianceView` purely to keep that module under the size gate. */
export function ComplianceOverviewTab({
  ratioChartData,
  ratios,
  slaQueue,
  settings,
}: {
  ratioChartData: readonly { category: string; values: { abandoned: number; silent: number } }[];
  ratios: readonly CliRatio[];
  slaQueue: readonly Complaint[];
  settings: SettingsRecord;
}) {
  const worst = ratios.reduce((max, row) => Math.max(max, row.abandonedRatio), 0);
  const worstLevel = ratios.find((row) => row.abandonedRatio === worst)?.level ?? 'ok';
  // Overdue first, then soonest-due within each group — a fresh, explicit sort at the point of
  // display rather than trusting the queue arrived in that order.
  const queue = [...slaQueue]
    .sort((a, b) => {
      if (Boolean(a.overdue) !== Boolean(b.overdue)) return a.overdue ? -1 : 1;
      const dueOf = (c: Complaint) =>
        Date.parse(c.overdue === 'ack' ? c.ackDueAt! : c.resolveDueAt);
      return dueOf(a) - dueOf(b);
    })
    .slice(0, 8);

  const slaColumns: ColumnV2<Complaint>[] = [
    { id: 'kind', header: 'Kind', cell: (row) => complaintKindLabel(row.kind) },
    {
      id: 'due',
      header: 'Status',
      cell: (row) => (
        <StatusBadgeV2
          tone={row.overdue ? 'danger' : 'neutral'}
          label={
            row.overdue === 'ack' && row.ackDueAt
              ? `Ack ${dueLabel(row.ackDueAt)}`
              : `Resolve ${dueLabel(row.resolveDueAt)}`
          }
        />
      ),
    },
  ];

  return (
    <div className="stack">
      {ratios.length > 0 && (
        <ProgressMeter
          label={`Worst abandoned ratio vs the ${BREAKER_PERCENT}% breaker`}
          value={worst * 100}
          max={BREAKER_PERCENT}
          threshold={BREAKER_PERCENT}
          tone={METER_TONE[worstLevel]}
          valueLabel={formatPercent(worst)}
        />
      )}
      <ChartFrame
        title="Abandoned & silent ratios by caller number"
        ariaLabel="Abandoned and silent call ratios by caller number, last 24 hours"
        empty={ratioChartData.length === 0}
        legend={
          <span className="muted" style={{ fontSize: 'var(--text-label-size)' }}>
            Breaker at {BREAKER_PERCENT}%
          </span>
        }
        tableRows={ratioChartData.length}
        tableColumns={[
          { header: 'Number', cell: (i) => ratioChartData[i]?.category },
          {
            header: 'Abandoned %',
            cell: (i) => {
              const value = ratioChartData[i]?.values.abandoned ?? 0;
              return value >= BREAKER_PERCENT ? (
                <StatusBadgeV2 tone="danger" label={`${value.toFixed(1)}%`} />
              ) : (
                `${value.toFixed(1)}`
              );
            },
          },
          { header: 'Silent %', cell: (i) => ratioChartData[i]?.values.silent.toFixed(1) },
        ]}
        renderChart={(width) => (
          <BarChart
            data={ratioChartData}
            seriesKeys={['abandoned', 'silent']}
            width={width}
            valueFormat={(v) => `${v.toFixed(1)}%`}
            seriesLabel={(key) => (key === 'abandoned' ? 'Abandoned' : 'Silent')}
          />
        )}
      />
      <SectionCard title="Complaint SLA queue" padding="flush">
        <DataTableV2
          key={queue.length === 0 ? 'empty' : 'data'}
          label="Complaint SLA queue"
          rows={queue}
          columns={slaColumns}
          rowKey={(row) => row.id}
          empty={<EmptyStateV2 title="No open complaints" />}
        />
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
