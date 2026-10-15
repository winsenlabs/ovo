'use client';
import { ChartFrame } from '../charts/chart-frame';
import { Waterfall } from '../charts/waterfall';
import { BarChart, type BarSeriesPoint } from '../charts/bar-chart';
import { LineChart } from '../charts/line-chart';
import { CHART_PALETTE, formatMsAxis } from '../charts/scale';
import { EmptyStateV2 } from '../ui/feedback-v2';
import {
  firstAudioSeries,
  stageBreakdown,
  turnWaterfall,
  STAGES,
  type TurnRow,
} from './turn-model';

/**
 * The Latency tab: one shared-axis waterfall of every turn's stages (capped at the p95, same as
 * the brief's original per-turn bars but with a real axis, legend and overflow gutter now), a
 * stage-breakdown bar of the median per stage, first-audio per turn against its own p50/p95, and
 * (minor #11) the evidence payload's own engine-side latency breakdown, which survives even when
 * `/turns` itself fails.
 */
export function LatencyTab({
  turns,
  error,
  onRetry,
  engineLatency,
}: {
  turns: readonly TurnRow[] | undefined;
  error?: string;
  onRetry?: () => void;
  engineLatency?: readonly BarSeriesPoint[];
}) {
  const loading = !error && !turns;
  const waterfall = turns ? turnWaterfall(turns) : undefined;
  const stages = turns ? stageBreakdown(turns) : [];
  const firstAudio = turns ? firstAudioSeries(turns) : undefined;
  // Minor #9: a legend built from `STAGES`' own fixed hues, rendered by `ChartFrame` outside the
  // chart's `role="img"` box (same spot the first-audio chart's legend already uses) rather than
  // only inside the SVG, where it rendered but was invisible to assistive tech and easy to miss
  // visually next to a fixed-height chart frame.
  const presentStageKeys = new Set(
    waterfall?.rows.flatMap((row) => row.stages.map((stage) => stage.stage)) ?? [],
  );
  const waterfallLegendStages = STAGES.filter((stage) => presentStageKeys.has(stage.label));

  if (!loading && !error && turns && turns.length === 0 && !engineLatency?.length)
    return (
      <EmptyStateV2 variant="first-run" title="No turn timings recorded">
        This call has no turn telemetry.
      </EmptyStateV2>
    );

  return (
    <div className="ds-stack">
      {engineLatency && engineLatency.length > 0 && (
        <ChartFrame
          title="Engine latency (evidence)"
          ariaLabel="Latency breakdown reported directly in the call's evidence payload"
          height={200}
          empty={!engineLatency.length}
          tableRows={engineLatency.length}
          tableColumns={[
            { header: 'Stage', cell: (i) => engineLatency[i]!.category },
            { header: 'Duration', cell: (i) => formatMsAxis(engineLatency[i]!.values.ms!) },
          ]}
          renderChart={(width) => (
            <BarChart
              width={width}
              height={200}
              data={engineLatency}
              seriesKeys={['ms']}
              valueFormat={formatMsAxis}
            />
          )}
        />
      )}
      <ChartFrame
        title="Stage breakdown"
        ariaLabel="Median latency per stage across turns"
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={!stages.length}
        height={200}
        tableRows={stages.length}
        tableColumns={[
          { header: 'Stage', cell: (i) => stages[i]!.category },
          { header: 'Median', cell: (i) => formatMsAxis(stages[i]!.values.median!) },
        ]}
        renderChart={(width) => (
          <BarChart
            width={width}
            height={200}
            data={stages}
            seriesKeys={['median']}
            valueFormat={formatMsAxis}
          />
        )}
      />
      <ChartFrame
        title="First audio per turn"
        ariaLabel="First audio time per answered turn, with the p50 and p95 reference lines"
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={!firstAudio?.points.length}
        height={220}
        legend={
          <ul className="ds-chart-legend">
            <li>
              <span className="ds-legend-swatch" style={{ background: CHART_PALETTE[0] }} />
              First audio
            </li>
            {firstAudio?.p50 != null && (
              <li>
                <span className="ds-legend-swatch" style={{ background: CHART_PALETTE[1] }} />
                p50
              </li>
            )}
            {firstAudio?.p95 != null && (
              <li>
                <span className="ds-legend-swatch" style={{ background: CHART_PALETTE[2] }} />
                p95
              </li>
            )}
          </ul>
        }
        tableRows={firstAudio?.points.length ?? 0}
        tableColumns={[
          { header: 'Turn', cell: (i) => firstAudio!.points[i]!.x },
          { header: 'First audio', cell: (i) => formatMsAxis(firstAudio!.points[i]!.y) },
        ]}
        renderChart={(width) =>
          firstAudio ? (
            <LineChart
              width={width}
              height={220}
              yFormat={formatMsAxis}
              series={[
                { key: 'first-audio', label: 'First audio', points: firstAudio.points },
                ...(firstAudio.p50 != null
                  ? [
                      {
                        key: 'p50',
                        label: 'p50',
                        points: firstAudio.points.map((point) => ({
                          x: point.x,
                          y: firstAudio.p50!,
                        })),
                      },
                    ]
                  : []),
                ...(firstAudio.p95 != null
                  ? [
                      {
                        key: 'p95',
                        label: 'p95',
                        points: firstAudio.points.map((point) => ({
                          x: point.x,
                          y: firstAudio.p95!,
                        })),
                      },
                    ]
                  : []),
              ]}
            />
          ) : null
        }
      />
      <ChartFrame
        title="Per-turn waterfall"
        ariaLabel="Per-turn latency breakdown by stage"
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={!waterfall?.rows.length}
        height={(waterfall?.rows.length ?? 0) * 28 + 60}
        legend={
          waterfallLegendStages.length > 0 ? (
            <ul className="ds-chart-legend">
              {waterfallLegendStages.map((stage) => (
                <li key={stage.key}>
                  <span className="ds-legend-swatch" style={{ background: stage.color }} />
                  {stage.label}
                </li>
              ))}
              <li>
                <span className="ds-legend-swatch" style={{ background: 'var(--surface-2)' }} />
                Unattributed
              </li>
            </ul>
          ) : undefined
        }
        tableRows={waterfall?.rows.length ?? 0}
        tableColumns={[
          { header: 'Turn', cell: (i) => waterfall!.rows[i]!.label },
          {
            header: 'Stages',
            cell: (i) =>
              waterfall!.rows[i]!.stages.map(
                (stage) => `${stage.stage} ${formatMsAxis(stage.ms)}`,
              ).join(', '),
          },
        ]}
        renderChart={(width) =>
          waterfall ? (
            <Waterfall width={width} rows={waterfall.rows} p95CapMs={waterfall.p95CapMs} />
          ) : null
        }
      />
    </div>
  );
}
