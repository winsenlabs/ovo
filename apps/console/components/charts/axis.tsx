import { niceTicks, type Scale } from './scale';

/** Horizontal axis along the bottom of a chart's plot area. */
export function XAxis({
  domain,
  scale,
  y,
  format,
  tickCount = 5,
}: {
  domain: readonly [number, number];
  scale: Scale;
  y: number;
  format: (value: number) => string;
  tickCount?: number;
}) {
  const ticks = niceTicks(domain, tickCount);
  return (
    <g className="ds-chart-axis" aria-hidden="true">
      {ticks.map((tick) => (
        <text key={tick} x={scale(tick)} y={y} textAnchor="middle" dy="1em">
          {format(tick)}
        </text>
      ))}
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
