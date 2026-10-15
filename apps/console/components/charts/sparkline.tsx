import { linearScale } from './scale';

/** Minimal inline trend line for a KPI card. No axes, no interaction — just shape. */
export function Sparkline({
  values,
  width = 64,
  height = 24,
  className,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = linearScale([0, values.length - 1], [1, width - 1]);
  const y = linearScale([min, max], [height - 1, 1]);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
  const summary = `Trend from ${values[0]} to ${values[values.length - 1]}`;
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={summary}
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
