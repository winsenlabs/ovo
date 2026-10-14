'use client';
import { BarChart } from '../../../components/charts/bar-chart';
import { ChartFrame } from '../../../components/charts/chart-frame';
import { Donut } from '../../../components/charts/donut';
import { HeatStrip } from '../../../components/charts/heat-strip';
import { LineChart } from '../../../components/charts/line-chart';
import { ProgressMeter } from '../../../components/charts/meter';
import { formatMsAxis } from '../../../components/charts/scale';
import { Waterfall } from '../../../components/charts/waterfall';
import { SectionCard } from '../../../components/ui/section-card';

/** Every hand-rolled SVG chart, each inside its `ChartFrame` Chart/Table shell. */
export function ChartsSection() {
  return (
    <SectionCard title="Charts">
      <div className="ds-kpi-strip">
        <ChartFrame
          ariaLabel="Calls per hour by status"
          tableColumns={[{ header: 'Hour', cell: (i) => i }]}
          tableRows={3}
          renderChart={(width) => (
            <LineChart
              width={width}
              series={[
                {
                  key: 'p95',
                  label: 'p95',
                  points: [
                    { x: 0, y: 320 },
                    { x: 1, y: 410 },
                    { x: 2, y: 280 },
                  ],
                },
              ]}
              yFormat={formatMsAxis}
            />
          )}
        />
        <ChartFrame
          ariaLabel="Calls by status"
          renderChart={(width) => (
            <BarChart
              width={width}
              seriesKeys={['completed', 'failed']}
              data={[
                { category: '10:00', values: { completed: 12, failed: 2 } },
                { category: '11:00', values: { completed: 9, failed: 4 } },
              ]}
            />
          )}
        />
      </div>
      <div className="ds-kpi-strip">
        <Donut
          slices={[
            { label: 'Promised to pay', value: 40 },
            { label: 'No disposition', value: 12 },
          ]}
          centerLabel="52"
        />
        <HeatStrip
          cells={[
            { day: 0, hour: 10, value: 8 },
            { day: 1, hour: 11, value: 14 },
          ]}
        />
      </div>
      <Waterfall
        width={640}
        p95CapMs={2000}
        rows={[
          {
            label: 'Turn 1',
            stages: [
              { stage: 'stt', ms: 300, color: 'var(--chart-6)' },
              { stage: 'llm', ms: 900, color: 'var(--chart-4)' },
              { stage: 'tts', ms: 400, color: 'var(--chart-1)' },
            ],
          },
        ]}
      />
      <ProgressMeter
        label="Worker capacity"
        max={100}
        threshold={85}
        valueLabel="62 / 100"
        segments={[
          { label: 'Busy', value: 42, tone: 'ok' },
          { label: 'Reserved', value: 20, tone: 'info' },
        ]}
      />
    </SectionCard>
  );
}
