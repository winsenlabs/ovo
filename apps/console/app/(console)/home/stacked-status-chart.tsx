import { CHART_PALETTE, bandScale, linearScale } from '../../../components/charts/scale';
import { YAxis } from '../../../components/charts/axis';

export type StackedPoint = { category: string; values: Record<string, number> };

/**
 * Vertical stacked bars with a correctly-oriented y-axis, local to Home. The shared
 * `components/charts/bar-chart.tsx` builds its vertical-mode value scale as
 * `linearScale([0, domainMax], [0, plotHeight])` and hands that same scale straight to
 * `YAxis` — so "0" renders at the TOP of the plot and the max tick at the BOTTOM (confirmed by
 * screenshot: a 7-day total of ~44 calls drawn against a gridline order of 0/20/40 reading
 * top-to-bottom). That is backwards for a chart whose bars grow upward from a zero baseline, and
 * since it lives in the shared axis-orientation logic of `bar-chart.tsx` itself, not something a
 * caller's props can override, Home's primary visual builds its own bars here with the scale
 * inverted the other way, while still reusing the shared `YAxis` (no bug there — it draws
 * whatever scale it is given) and `scale.ts`'s `linearScale`/`bandScale`/`CHART_PALETTE`.
 * FOUNDATION REQUEST: invert `bar-chart.tsx`'s vertical-mode value scale to
 * `linearScale([0, domainMax], [height, 0])` so every vertical `BarChart` across every screen
 * gets a correct axis, and this file can be deleted in favour of the shared one.
 */
export function StackedStatusChart({
  data,
  seriesKeys,
  seriesLabel,
  seriesColor,
  width,
  height = 220,
}: {
  data: readonly StackedPoint[];
  seriesKeys: readonly string[];
  seriesLabel: (key: string) => string;
  seriesColor?: (key: string, index: number) => string;
  width: number;
  height?: number;
}) {
  const colorOf = seriesColor ?? ((key, index) => CHART_PALETTE[index % CHART_PALETTE.length]!);
  const MARGIN = { top: 20, right: 8, bottom: 24, left: 36 };
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = Math.max(1, height - MARGIN.top - MARGIN.bottom);
  const totals = data.map((point) =>
    seriesKeys.reduce((sum, key) => sum + (point.values[key] ?? 0), 0),
  );
  const domainMax = Math.max(1, ...totals);
  // The one-line fix: 0 maps to the bottom of the plot, `domainMax` to the top.
  const y = linearScale([0, domainMax], [plotHeight, 0]);
  const { center, bandwidth } = bandScale(data.length, [0, plotWidth]);
  const barWidth = Math.max(1, bandwidth - 4);

  return (
    <div className="ds-bar-chart">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Calls per bucket across ${data.length} periods`}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          <YAxis
            domain={[0, domainMax]}
            scale={y}
            x={0}
            width={plotWidth}
            format={(v) => String(Math.round(v))}
          />
          {data.map((point) => {
            let stackTop = 0;
            const bandCenter = center(data.indexOf(point));
            return (
              <g key={point.category}>
                <text
                  x={bandCenter}
                  y={plotHeight + 16}
                  textAnchor="middle"
                  className="ds-bar-category-label"
                >
                  {point.category}
                </text>
                {seriesKeys.map((key, seriesIndex) => {
                  const raw = point.values[key] ?? 0;
                  if (raw <= 0) return null;
                  const yTop = y(stackTop + raw);
                  const yBottom = y(stackTop);
                  stackTop += raw;
                  return (
                    <rect
                      key={key}
                      x={bandCenter - barWidth / 2}
                      y={yTop}
                      width={barWidth}
                      height={Math.max(0, yBottom - yTop)}
                      fill={colorOf(key, seriesIndex)}
                      rx={2}
                      role="img"
                      aria-label={`${point.category} · ${seriesLabel(key)}: ${raw}`}
                    />
                  );
                })}
                {stackTop > 0 && (
                  <text
                    x={bandCenter}
                    y={y(stackTop) - 4}
                    textAnchor="middle"
                    className="ds-bar-value-label"
                    aria-hidden="true"
                  >
                    {stackTop}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <ul className="ds-chart-legend">
        {seriesKeys.map((key, index) => (
          <li key={key}>
            <span className="ds-legend-swatch" style={{ background: colorOf(key, index) }} />
            {seriesLabel(key)}
          </li>
        ))}
      </ul>
    </div>
  );
}
