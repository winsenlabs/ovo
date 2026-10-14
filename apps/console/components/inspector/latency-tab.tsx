'use client';
import { ChartFrame } from '../charts/chart-frame';
import { Waterfall } from '../charts/waterfall';
import { BarChart } from '../charts/bar-chart';
import { LineChart } from '../charts/line-chart';
import { CHART_PALETTE, formatMsAxis } from '../charts/scale';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { firstAudioSeries, stageBreakdown, turnWaterfall, type TurnRow } from './turn-model';

/**
 * The Latency tab: one shared-axis waterfall of every turn's stages (capped at the p95, same as
 * the brief's original per-turn bars but with a real axis, legend and overflow gutter now), a
 * stage-breakdown bar of the median per stage, and first-audio per turn against its own p50/p95.
 */
export function LatencyTab({
  turns,
  error,
  onRetry,
}: {
  turns: readonly TurnRow[] | undefined;
  error?: string;
  onRetry?: () => void;
}) {
  const loading = !error && !turns;
  const waterfall = turns ? turnWaterfall(turns) : undefined;
  const stages = turns ? stageBreakdown(turns) : [];
  const firstAudio = turns ? firstAudioSeries(turns) : undefined;

  if (!loading && !error && turns && turns.length === 0)
    return (
      <EmptyStateV2 variant="first-run" title="No turn timings recorded">
        This call has no turn telemetry.
      </EmptyStateV2>
    );

  return (
    <div className="ds-stack">
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
        height={(waterfall?.rows.length ?? 0) * 28 + 48}
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
