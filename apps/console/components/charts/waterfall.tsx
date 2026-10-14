import { formatMsAxis, linearScale } from './scale';
import { XAxis } from './axis';

export type WaterfallStage = { stage: string; ms: number; color: string };
export type WaterfallRow = {
  label: string;
  stages: readonly WaterfallStage[];
  unattributedMs?: number;
};

const ROW_HEIGHT = 28;
// `right` reserves a gutter for the "+Nms" overflow marker so it never sits on top of a stage
// bar that runs to the plot edge underneath it (brief defect #7).
const MARGIN = { top: 4, right: 56, bottom: 24, left: 88 };

/**
 * One shared ms x-axis, rows = turns, stacked stage segments, with a p95 cap marker, an overflow
 * gutter for rows that exceed it, a hatched fill for the unattributed segment, and a legend.
 */
export function Waterfall({
  rows,
  width,
  p95CapMs,
}: {
  rows: readonly WaterfallRow[];
  width: number;
  p95CapMs: number;
}) {
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const chartHeight = rows.length * ROW_HEIGHT + MARGIN.top + MARGIN.bottom;
  const axisHeight = chartHeight + 20;
  const x = linearScale([0, p95CapMs], [0, plotWidth]);
  const legendStages = new Map<string, string>();
  for (const row of rows)
    for (const stage of row.stages) legendStages.set(stage.stage, stage.color);

  return (
    <div className="ds-waterfall">
      <svg
        width={width}
        height={axisHeight}
        viewBox={`0 0 ${width} ${axisHeight}`}
        role="img"
        aria-label="Per-turn latency waterfall, capped at the p95"
      >
        <defs>
          <pattern
            id="ds-hatch-unattributed"
            width={6}
            height={6}
            patternTransform="rotate(45)"
            patternUnits="userSpaceOnUse"
          >
            <rect width={6} height={6} fill="var(--surface-2)" />
            <line x1={0} y1={0} x2={0} y2={6} stroke="var(--text-3)" strokeWidth={2} />
          </pattern>
        </defs>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          <XAxis
            domain={[0, p95CapMs]}
            scale={x}
            y={chartHeight - MARGIN.top}
            format={formatMsAxis}
            width={plotWidth}
          />
          <line
            x1={x(p95CapMs)}
            x2={x(p95CapMs)}
            y1={0}
            y2={chartHeight - MARGIN.top}
            className="ds-waterfall-p95-line"
          />
          <text x={x(p95CapMs)} y={-2} textAnchor="middle" className="ds-waterfall-p95-label">
            p95
          </text>
          {rows.map((row, rowIndex) => {
            const total =
              row.stages.reduce((sum, stage) => sum + stage.ms, 0) + (row.unattributedMs ?? 0);
            const overflow = total > p95CapMs;
            let offset = 0;
            return (
              <g key={row.label} transform={`translate(0,${rowIndex * ROW_HEIGHT})`}>
                <text
                  x={-8}
                  y={ROW_HEIGHT / 2}
                  textAnchor="end"
                  dy="0.32em"
                  className="ds-chart-row-label"
                >
                  {row.label}
                </text>
                {row.stages.map((stage) => {
                  // Clamp at the plot edge: an unclamped stacked offset can run the bar's pixel
                  // width past p95CapMs and under the overflow gutter's text (brief defect #7).
                  const start = Math.min(x(offset), plotWidth);
                  offset += stage.ms;
                  const end = Math.min(x(offset), plotWidth);
                  return (
                    <rect
                      key={stage.stage}
                      x={start}
                      y={4}
                      width={Math.max(0, end - start)}
                      height={ROW_HEIGHT - 10}
                      fill={stage.color}
                      rx={2}
                      role="img"
                      aria-label={`${stage.stage}: ${formatMsAxis(stage.ms)}`}
                    />
                  );
                })}
                {row.unattributedMs && row.unattributedMs > 0 && (
                  <rect
                    x={Math.min(x(offset), plotWidth)}
                    y={4}
                    width={Math.max(
                      0,
                      Math.min(x(offset + row.unattributedMs), plotWidth) -
                        Math.min(x(offset), plotWidth),
                    )}
                    height={ROW_HEIGHT - 10}
                    fill="url(#ds-hatch-unattributed)"
                    role="img"
                    aria-label={`Unattributed: ${formatMsAxis(row.unattributedMs)}`}
                  />
                )}
                {overflow && (
                  <text
                    x={plotWidth + 8}
                    y={ROW_HEIGHT / 2}
                    textAnchor="start"
                    dy="0.32em"
                    className="ds-waterfall-overflow"
                  >
                    +{formatMsAxis(total - p95CapMs)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <ul className="ds-chart-legend">
        {[...legendStages.entries()].map(([stage, color]) => (
          <li key={stage}>
            <span className="ds-legend-swatch" style={{ background: color }} />
            {stage}
          </li>
        ))}
        <li>
          <span className="ds-legend-swatch" style={{ background: 'var(--surface-2)' }} />
          Unattributed
        </li>
      </ul>
    </div>
  );
}
