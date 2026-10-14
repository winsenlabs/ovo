'use client';
import { useState } from 'react';
import { CHART_PALETTE, linearScale } from './scale';
import { XAxis, YAxis } from './axis';

export type LineSeries = {
  key: string;
  label: string;
  points: readonly { x: number; y: number }[];
};

const MARGIN = { top: 8, right: 16, bottom: 24, left: 48 };

/**
 * Multi-series line chart with an optional area fill, hover crosshair + tooltip, and
 * keyboard-focusable points (tab through, read value via `aria-label`).
 */
export function LineChart({
  series,
  width,
  height = 220,
  area = false,
  xFormat = String,
  yFormat = String,
  yMax,
}: {
  series: readonly LineSeries[];
  width: number;
  height?: number;
  area?: boolean;
  xFormat?: (value: number) => string;
  yFormat?: (value: number) => string;
  yMax?: number;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = Math.max(1, height - MARGIN.top - MARGIN.bottom);
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const xDomain: [number, number] = [Math.min(...xs, 0), Math.max(...xs, 1)];
  const yDomain: [number, number] = [0, yMax ?? Math.max(1, ...ys)];
  const x = linearScale(xDomain, [0, plotWidth]);
  const y = linearScale(yDomain, [plotHeight, 0]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Line chart, ${series.length} series`}
      onMouseLeave={() => setHover(null)}
    >
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        <YAxis domain={yDomain} scale={y} x={0} width={plotWidth} format={yFormat} />
        <XAxis domain={xDomain} scale={x} y={plotHeight} format={xFormat} />
        {series.map((s, seriesIndex) => {
          const color = CHART_PALETTE[seriesIndex % CHART_PALETTE.length];
          const linePath = s.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x)},${y(p.y)}`)
            .join(' ');
          const areaPath = area
            ? `${linePath} L${x(s.points.at(-1)?.x ?? 0)},${plotHeight} L${x(s.points[0]?.x ?? 0)},${plotHeight} Z`
            : null;
          return (
            <g key={s.key}>
              {areaPath && <path d={areaPath} fill={color} opacity={0.12} stroke="none" />}
              <path
                d={linePath}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {s.points.map((point, index) => (
                <circle
                  key={index}
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={3}
                  fill={color}
                  tabIndex={0}
                  role="img"
                  aria-label={`${s.label} at ${xFormat(point.x)}: ${yFormat(point.y)}`}
                  onMouseEnter={() =>
                    setHover({
                      x: x(point.x),
                      y: y(point.y),
                      label: `${s.label}: ${yFormat(point.y)}`,
                    })
                  }
                  onFocus={() =>
                    setHover({
                      x: x(point.x),
                      y: y(point.y),
                      label: `${s.label}: ${yFormat(point.y)}`,
                    })
                  }
                />
              ))}
            </g>
          );
        })}
        {hover && (
          <g transform={`translate(${hover.x},${hover.y})`} className="ds-chart-tooltip">
            <line y2={plotHeight - hover.y} stroke="var(--border-strong)" />
            <rect x={6} y={-20} width={hover.label.length * 6 + 12} height={18} rx={4} />
            <text x={12} y={-7}>
              {hover.label}
            </text>
          </g>
        )}
      </g>
    </svg>
  );
}
