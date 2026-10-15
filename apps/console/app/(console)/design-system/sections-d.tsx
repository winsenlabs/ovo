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

// A real 24-hour epoch-ms series — not x = 0, 1, 2 — so a time chart's own demo would have caught
// it collapsing to one vertical strip at the right (brief defect #3).
const HOUR_MS = 3_600_000;
const SERIES_START = Date.UTC(2026, 9, 14, 0, 0, 0);
const P95_SERIES = Array.from({ length: 24 }, (_, hour) => ({
  x: SERIES_START + hour * HOUR_MS,
  y: 280 + Math.round(120 * Math.sin(hour / 3)),
}));

function hourOfDay(epochMs: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(new Date(epochMs));
}

/** Every hand-rolled SVG chart, each inside its `ChartFrame` Chart/Table shell. */
export function ChartsSection() {
  return (
    <SectionCard title="Charts">
      <div className="ds-kpi-strip">
        <ChartFrame
          title="First-audio p95 over time"
          ariaLabel="First-audio p95 over 24 hours"
          tableColumns={[
            { header: 'Hour', cell: (i) => hourOfDay(P95_SERIES[i].x) },
            { header: 'p95', cell: (i) => formatMsAxis(P95_SERIES[i].y) },
          ]}
          tableRows={P95_SERIES.length}
          renderChart={(width) => (
            <LineChart
              width={width}
              xScale="time"
              series={[{ key: 'p95', label: 'p95', points: P95_SERIES }]}
              xFormat={hourOfDay}
              yFormat={formatMsAxis}
            />
          )}
        />
        <ChartFrame
          title="Calls by status"
          ariaLabel="Calls by status"
          renderChart={(width) => (
            <BarChart
              width={width}
              seriesKeys={['completed', 'failed']}
              seriesLabel={(key) => (key === 'completed' ? 'Completed' : 'Failed')}
              data={[
                { category: '10:00', values: { completed: 12, failed: 2 } },
                { category: '11:00', values: { completed: 9, failed: 4 } },
              ]}
            />
          )}
        />
      </div>
      <div className="ds-kpi-strip">
        <ChartFrame
          title="Donut, multiple slices"
          ariaLabel="Outcomes by disposition"
          height={176}
          renderChart={() => (
            <Donut
              slices={[
                { label: 'Promised to pay', value: 40 },
                { label: 'No disposition', value: 12 },
              ]}
              centerLabel="52"
            />
          )}
        />
        {/* Regression fixture for defect #6: a single 100%-share category used to render a blank
            ring (the arc's start and end points coincided). */}
        <ChartFrame
          title="Donut, single slice"
          ariaLabel="All calls completed"
          height={176}
          renderChart={() => (
            <Donut slices={[{ label: 'Completed', value: 52 }]} centerLabel="52" />
          )}
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
          {
            // Exercises the overflow gutter and the hatched unattributed segment together: this
            // turn's total runs past the p95 cap.
            label: 'Turn 4',
            stages: [
              { stage: 'stt', ms: 300, color: 'var(--chart-6)' },
              { stage: 'llm', ms: 1800, color: 'var(--chart-4)' },
              { stage: 'tts', ms: 600, color: 'var(--chart-1)' },
            ],
            unattributedMs: 200,
          },
        ]}
      />
      <div className="ds-kpi-strip">
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
        {/* Regression fixture for the overspend defect: 120 of a 100 budget used to be clamped
            invisibly to 100% by the track's overflow:hidden, with no indication it was over. */}
        <ProgressMeter
          label="Monthly budget"
          max={100}
          valueLabel="₹1,20,000 / ₹1,00,000"
          value={120}
        />
      </div>
    </SectionCard>
  );
}
