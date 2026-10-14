import { CHART_PALETTE } from './scale';

export type DonutSlice = { label: string; value: number };
const MAX_SLICES = 6;

function arcPath(
  cx: number,
  cy: number,
  r: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const point = (angle: number, radius: number) => [
    cx + radius * Math.cos(angle),
    cy + radius * Math.sin(angle),
  ];
  const [x0, y0] = point(startAngle, r);
  const [x1, y1] = point(endAngle, r);
  const [x2, y2] = point(endAngle, innerR);
  const [x3, y3] = point(startAngle, innerR);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${innerR},${innerR} 0 ${large} 0 ${x3},${y3} Z`;
}

/** ≤6 slices + "Other", centre total. Collapses extra categories so colour stays legible. */
export function Donut({
  slices,
  size = 160,
  centerLabel,
  formatValue = String,
}: {
  slices: readonly DonutSlice[];
  size?: number;
  centerLabel?: string;
  formatValue?: (value: number) => string;
}) {
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, MAX_SLICES);
  const rest = sorted.slice(MAX_SLICES).reduce((sum, slice) => sum + slice.value, 0);
  const shown = rest > 0 ? [...top, { label: 'Other', value: rest }] : top;
  const total = shown.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const r = size / 2 - 4;
  const innerR = r * 0.62;
  let angle = -Math.PI / 2;

  return (
    <div className="ds-donut">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${shown.map((s) => `${s.label} ${formatValue(s.value)}`).join(', ')}`}
      >
        {shown.map((slice, index) => {
          const sweep = (slice.value / total) * Math.PI * 2;
          const path = arcPath(size / 2, size / 2, r, innerR, angle, angle + sweep);
          angle += sweep;
          return (
            <path
              key={slice.label}
              d={path}
              fill={CHART_PALETTE[index % CHART_PALETTE.length]}
              role="img"
              aria-label={`${slice.label}: ${formatValue(slice.value)}`}
            />
          );
        })}
        {centerLabel && (
          <text
            x={size / 2}
            y={size / 2}
            textAnchor="middle"
            dy="0.35em"
            className="ds-donut-center"
          >
            {centerLabel}
          </text>
        )}
      </svg>
      <ul className="ds-chart-legend">
        {shown.map((slice, index) => (
          <li key={slice.label}>
            <span
              className="ds-legend-swatch"
              style={{ background: CHART_PALETTE[index % CHART_PALETTE.length] }}
            />
            {slice.label} · {formatValue(slice.value)}
          </li>
        ))}
      </ul>
    </div>
  );
}
