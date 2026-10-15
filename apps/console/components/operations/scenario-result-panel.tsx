'use client';
import type { ScenarioResult } from '../../lib/operator-api';
import { formatMoney } from '../../lib/format';
import { scenarioBreakdownBars, scenarioMeter } from '../../lib/derive/costs';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { ChartFrame } from '../charts/chart-frame';
import { BarChart } from '../charts/bar-chart';
import { ProgressMeter } from '../charts/meter';
import { InlineAlert } from '../ui/feedback-v2';

/** The scenario calculator's result half — KPI strip, spent-vs-target meter and cost-breakdown
 * bar — extracted so `ScenarioPanel` stays under the module-size gate. */
export function ScenarioResultPanel({ result }: { result: ScenarioResult | undefined }) {
  const bars = result ? scenarioBreakdownBars(result) : [];
  const meter = result ? scenarioMeter(result) : null;

  return (
    <SectionCard title="Result" description="Cost breakdown against the target revenue.">
      {!result ? (
        <InlineAlert tone="info">Run the scenario to see the cost breakdown.</InlineAlert>
      ) : (
        <div className="ds-stack">
          <KpiStrip>
            <KpiCard label="Total cost" value={formatMoney(result.totalCostPaise)} />
            <KpiCard
              label="Margin"
              value={formatMoney(result.marginPaise)}
              footnote={result.marginScope}
            />
            <KpiCard
              label="Target"
              value={
                <StatusBadgeV2
                  tone={result.withinTarget ? 'ok' : 'danger'}
                  label={result.withinTarget ? 'Within' : 'Exceeded'}
                />
              }
              footnote={formatMoney(result.targetRevenuePaise)}
            />
          </KpiStrip>
          {meter && (
            <ProgressMeter
              label="Cost vs target revenue"
              segments={meter.segments}
              max={meter.max}
              valueLabel={`${formatMoney(result.totalCostPaise)} of ${formatMoney(result.targetRevenuePaise)}`}
            />
          )}
          <ChartFrame
            ariaLabel="Cost breakdown by category"
            // 5 categories × a bar each, plus the x-axis, didn't fit in 180px: labels clipped
            // ("peech generation") and the axis itself was cut off (verifier minor #15).
            height={240}
            tableRows={bars.length}
            tableColumns={[
              { header: 'Category', cell: (i) => bars[i]?.category },
              { header: 'Amount', cell: (i) => formatMoney((bars[i]?.values.amount ?? 0) * 100) },
            ]}
            renderChart={(width) => (
              <BarChart
                data={bars}
                seriesKeys={['amount']}
                width={width}
                orientation="horizontal"
                valueFormat={(value) => formatMoney(value * 100)}
              />
            )}
          />
        </div>
      )}
    </SectionCard>
  );
}
