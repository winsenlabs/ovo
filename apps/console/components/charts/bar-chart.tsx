import { CHART_PALETTE, bandScale, linearScale } from './scale';
import { XAxis, YAxis } from './axis';

export type BarSeriesPoint = { category: string; values: Record<string, number> };

/**
 * Grouped or stacked vertical/horizontal bars with a value axis, category labels, per-bar value
 * labels and (for more than one series) a legend — colour alone never carries the meaning here.
 * `seriesKeys` controls stacking order and legend/colour assignment from the shared
 * `CHART_PALETTE`; pass `seriesLabel` to humanise a raw key for the legend.
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
  seriesLabel,
}: {
  data: readonly BarSeriesPoint[];
  seriesKeys: readonly string[];
  width: number;
  height?: number;
  orientation?: 'vertical' | 'horizontal';
  mode?: 'grouped' | 'stacked';
  valueFormat?: (value: number) => string;
  seriesColor?: (key: string, index: number) => string;
  seriesLabel?: (key: string) => string;
}) {
  const colorOf = seriesColor ?? ((key, index) => CHART_PALETTE[index % CHART_PALETTE.length]);
  const labelOf = seriesLabel ?? ((key: string) => key);
  const isVertical = orientation === 'vertical';
  const MARGIN = isVertical
    ? { top: 20, right: 8, bottom: 24, left: 40 }
    : { top: 8, right: 36, bottom: 24, left: 104 };
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = Math.max(1, height - MARGIN.top - MARGIN.bottom);
  const main = isVertical ? plotHeight : plotWidth;
  const cross = isVertical ? plotWidth : plotHeight;
  const totals = data.map((point) =>
    seriesKeys.reduce((sum, key) => sum + (point.values[key] ?? 0), 0),
  );
  const maxStacked = Math.max(1, ...totals);
  const maxSingle = Math.max(
    1,
    ...data.flatMap((point) => seriesKeys.map((key) => point.values[key] ?? 0)),
  );
  const domainMax = mode === 'stacked' ? maxStacked : maxSingle;
  // `value` maps a datum to a bar *length* (0 -> 0), which is what the rects need in both
  // orientations. The vertical y-axis needs a *position* instead — SVG y grows downward, so zero
  // sits at the bottom of the plot and `domainMax` at the top; handing the axis `value` drew the
  // tick labels upside down (max at the bottom) on every vertical bar chart.
  const value = linearScale([0, domainMax], [0, main]);
  const yPosition = linearScale([0, domainMax], [plotHeight, 0]);
  const { center, bandwidth } = bandScale(data.length, [0, cross]);
  // At least 1px: with many grouped series the naive `bandwidth / seriesKeys.length - 2` can go
  // negative, which SVG silently renders as nothing — the bars just vanish (brief defect #5).
  const groupWidth = Math.max(
    1,
    mode === 'grouped' ? bandwidth / seriesKeys.length - 2 : bandwidth - 2,
  );

  return (
    <div className="ds-bar-chart">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Bar chart across ${data.length} categories`}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {isVertical ? (
            <YAxis
              domain={[0, domainMax]}
              scale={yPosition}
              x={0}
              width={plotWidth}
              format={valueFormat}
            />
          ) : (
            <XAxis
              domain={[0, domainMax]}
              scale={value}
              y={plotHeight}
              format={valueFormat}
              width={plotWidth}
            />
          )}
          {data.map((point, categoryIndex) => {
            let stackOffset = 0;
            const bandCenter = center(categoryIndex);
            // Stacked bars carry one value label — the stack total, above its topmost non-empty
            // segment — rather than one per segment, which printed a pile of overlapping "0"s
            // for every empty series at the top of each stack.
            const topSegment =
              mode === 'stacked'
                ? seriesKeys.reduce(
                    (last, key, index) => ((point.values[key] ?? 0) > 0 ? index : last),
                    -1,
                  )
                : -1;
            // One keyed `<g>` per category, never a bare array of arrays: a nested map returning
            // arrays of siblings with the same `key` (the series name) across every category
            // confuses React's reconciliation between the server and client render.
            return (
              <g key={point.category}>
                {isVertical ? (
                  <text
                    x={bandCenter}
                    y={plotHeight + 16}
                    textAnchor="middle"
                    className="ds-bar-category-label"
                  >
                    {point.category}
                  </text>
                ) : (
                  <text
                    x={-8}
                    y={bandCenter}
                    dy="0.32em"
                    textAnchor="end"
                    className="ds-bar-category-label"
                  >
                    {point.category}
                  </text>
                )}
                {seriesKeys.map((key, seriesIndex) => {
                  const raw = point.values[key] ?? 0;
                  const length = value(raw);
                  const crossPosition =
                    mode === 'grouped'
                      ? bandCenter - bandwidth / 2 + seriesIndex * (groupWidth + 2)
                      : bandCenter - bandwidth / 2;
                  const mainStart = mode === 'stacked' ? stackOffset : 0;
                  stackOffset += length;
                  const color = colorOf(key, seriesIndex);
                  // aria-label, not a nested <title>: React 19 hoists a literal <title> tag to
                  // <head> as document metadata even inside an <svg>, which mismatches between
                  // server and client when a chart has more than one bar (hydration error #418).
                  const barLabel = `${point.category} · ${labelOf(key)}: ${valueFormat(raw)}`;
                  const showValue = mode !== 'stacked' || seriesIndex === topSegment;
                  const shownValue = valueFormat(
                    mode === 'stacked' ? (totals[categoryIndex] ?? raw) : raw,
                  );
                  return isVertical ? (
                    <g key={key}>
                      <rect
                        x={crossPosition}
                        y={plotHeight - mainStart - length}
                        width={groupWidth}
                        height={length}
                        fill={color}
                        rx={2}
                        role="img"
                        aria-label={barLabel}
                      />
                      {showValue && (
                        <text
                          x={crossPosition + groupWidth / 2}
                          y={plotHeight - mainStart - length - 4}
                          textAnchor="middle"
                          className="ds-bar-value-label"
                          aria-hidden="true"
                        >
                          {shownValue}
                        </text>
                      )}
                    </g>
                  ) : (
                    <g key={key}>
                      <rect
                        x={mainStart}
                        y={crossPosition}
                        width={length}
                        height={groupWidth}
                        fill={color}
                        rx={2}
                        role="img"
                        aria-label={barLabel}
                      />
                      {showValue && (
                        <text
                          x={mainStart + length + 4}
                          y={crossPosition + groupWidth / 2}
                          dy="0.32em"
                          textAnchor="start"
                          className="ds-bar-value-label"
                          aria-hidden="true"
                        >
                          {shownValue}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>
      {seriesKeys.length > 1 && (
        <ul className="ds-chart-legend">
          {seriesKeys.map((key, index) => (
            <li key={key}>
              <span className="ds-legend-swatch" style={{ background: colorOf(key, index) }} />
              {labelOf(key)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
