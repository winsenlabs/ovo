import { formatMsAxis, linearScale } from './scale';

export type WaterfallStage = { stage: string; ms: number; color: string };
export type WaterfallRow = {
  label: string;
  stages: readonly WaterfallStage[];
  unattributedMs?: number;
};

const ROW_HEIGHT = 28;
const MARGIN = { top: 4, right: 8, bottom: 20, left: 88 };

/**
 * One shared ms x-axis, rows = turns, stacked stage segments. `p95CapMs` clips the axis and
 * draws an overflow marker on rows that exceed it, per the brief's existing latency chart spec.
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
  const height = rows.length * ROW_HEIGHT + MARGIN.top + MARGIN.bottom;
  const x = linearScale([0, p95CapMs], [0, plotWidth]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Per-turn latency waterfall, capped at the p95"
    >
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
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
                const start = x(offset);
                offset += stage.ms;
                const end = x(offset);
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
                  x={x(offset)}
                  y={4}
                  width={Math.max(0, x(offset + row.unattributedMs) - x(offset))}
                  height={ROW_HEIGHT - 10}
                  fill="var(--surface-2)"
                  className="ds-waterfall-unattributed"
                />
              )}
              {overflow && (
                <text
                  x={plotWidth - 4}
                  y={ROW_HEIGHT / 2}
                  textAnchor="end"
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
  );
}
