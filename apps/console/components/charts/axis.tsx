import { niceTicks, niceTimeTicks, type Scale } from './scale';

/**
 * Horizontal axis along the bottom of a chart's plot area. `mode="time"` aligns ticks to
 * calendar-friendly steps (minute/hour/day) for an epoch-ms domain instead of `niceTicks`'s
 * power-of-ten stepping. `width`, when given, right/left-anchors the first and last tick labels
 * so they stay inside the plot instead of bleeding into the axis margin and colliding with the
 * y-axis label there (the "0ms y tick overlaps the first x tick" defect).
 */
export function XAxis({
  domain,
  scale,
  y,
  format,
  tickCount = 5,
  mode = 'linear',
  width,
}: {
  domain: readonly [number, number];
  scale: Scale;
  y: number;
  format: (value: number) => string;
  tickCount?: number;
  mode?: 'linear' | 'time';
  width?: number;
}) {
  // One tick per ~90px at most: a fixed count of five ran time labels ("05:30 pm08:30 pm") into
  // each other on a phone-width plot.
  const count =
    width != null ? Math.max(2, Math.min(tickCount, Math.floor(width / 90))) : tickCount;
  const ticks = mode === 'time' ? niceTimeTicks(domain, count) : niceTicks(domain, count);
  const edgeThreshold = 20;
  return (
    <g className="ds-chart-axis" aria-hidden="true">
      {ticks.map((tick) => {
        const x = scale(tick);
        const anchor =
          width != null && x <= edgeThreshold
            ? 'start'
            : width != null && x >= width - edgeThreshold
              ? 'end'
              : 'middle';
        return (
          <text key={tick} x={x} y={y} textAnchor={anchor} dy="1em">
            {format(tick)}
          </text>
        );
      })}
    </g>
  );
}

/** Vertical axis down the left of a chart's plot area. */
export function YAxis({
  domain,
  scale,
  x,
  width,
  format,
  tickCount = 4,
}: {
  domain: readonly [number, number];
  scale: Scale;
  x: number;
  width: number;
  format: (value: number) => string;
  tickCount?: number;
}) {
  const ticks = niceTicks(domain, tickCount);
  return (
    <g className="ds-chart-axis" aria-hidden="true">
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={x}
            x2={x + width}
            y1={scale(tick)}
            y2={scale(tick)}
            className="ds-chart-gridline"
          />
          <text x={x - 8} y={scale(tick)} textAnchor="end" dy="0.32em">
            {format(tick)}
          </text>
        </g>
      ))}
    </g>
  );
}
