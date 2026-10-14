import { CHART_PALETTE, bandScale, linearScale } from './scale';

export type BarSeriesPoint = { category: string; values: Record<string, number> };

const MARGIN = { top: 8, right: 8, bottom: 24, left: 8 };

/**
 * Grouped or stacked vertical/horizontal bars with value labels. `seriesKeys` controls stacking
 * order and legend/colour assignment from the shared `CHART_PALETTE`.
 */
export function BarChart({
  data,
  seriesKeys,
  width,
  height = 200,
  orientation = 'vertical',
  mode = 'grouped',
  valueFormat = String,
  seriesColor,
}: {
  data: readonly BarSeriesPoint[];
  seriesKeys: readonly string[];
  width: number;
  height?: number;
  orientation?: 'vertical' | 'horizontal';
  mode?: 'grouped' | 'stacked';
  valueFormat?: (value: number) => string;
  seriesColor?: (key: string, index: number) => string;
}) {
  const colorOf = seriesColor ?? ((key, index) => CHART_PALETTE[index % CHART_PALETTE.length]);
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const main = orientation === 'vertical' ? plotHeight : plotWidth;
  const cross = orientation === 'vertical' ? plotWidth : plotHeight;
  const totals = data.map((point) =>
    seriesKeys.reduce((sum, key) => sum + (point.values[key] ?? 0), 0),
  );
  const maxStacked = Math.max(1, ...totals);
  const maxSingle = Math.max(
    1,
    ...data.flatMap((point) => seriesKeys.map((key) => point.values[key] ?? 0)),
  );
  const domainMax = mode === 'stacked' ? maxStacked : maxSingle;
  const value = linearScale([0, domainMax], [0, main]);
  const { center, bandwidth } = bandScale(data.length, [0, cross]);
  const groupWidth = mode === 'grouped' ? bandwidth / seriesKeys.length : bandwidth;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Bar chart across ${data.length} categories`}
    >
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {data.map((point, categoryIndex) => {
          let stackOffset = 0;
          // One keyed `<g>` per category, never a bare array of arrays: a nested map returning
          // arrays of siblings with the same `key` (the series name) across every category
          // confuses React's reconciliation between the server and client render.
          return (
            <g key={point.category}>
              {seriesKeys.map((key, seriesIndex) => {
                const raw = point.values[key] ?? 0;
                const length = value(raw);
                const crossPosition =
                  mode === 'grouped'
                    ? center(categoryIndex) - bandwidth / 2 + seriesIndex * groupWidth
                    : center(categoryIndex) - bandwidth / 2;
                const mainStart = mode === 'stacked' ? stackOffset : 0;
                stackOffset += length;
                const color = colorOf(key, seriesIndex);
                // aria-label, not a nested <title>: React 19 hoists a literal <title> tag to
                // <head> as document metadata even inside an <svg>, which mismatches between
                // server and client when a chart has more than one bar (hydration error #418).
                const barLabel = `${point.category} · ${key}: ${valueFormat(raw)}`;
                return orientation === 'vertical' ? (
                  <rect
                    key={key}
                    x={crossPosition}
                    y={plotHeight - mainStart - length}
                    width={groupWidth - 2}
                    height={length}
                    fill={color}
                    rx={2}
                    role="img"
                    aria-label={barLabel}
                  />
                ) : (
                  <rect
                    key={key}
                    x={mainStart}
                    y={crossPosition}
                    width={length}
                    height={groupWidth - 2}
                    fill={color}
                    rx={2}
                    role="img"
                    aria-label={barLabel}
                  />
                );
              })}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
