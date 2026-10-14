'use client';
import { useState } from 'react';
import { CHART_PALETTE, linearScale } from './scale';
import { XAxis, YAxis } from './axis';

export type LineSeries = {
  key: string;
  label: string;
  points: readonly { x: number; y: number }[];
  /** Optional p50–p95 (or similar) band, rendered as a translucent area behind the line. */
  band?: readonly { x: number; low: number; high: number }[];
};

const MARGIN = { top: 8, right: 16, bottom: 24, left: 48 };

/**
 * Multi-series line chart with an optional area fill, hover crosshair + tooltip, and
 * keyboard-focusable points (tab through, read value via `aria-label`). `xScale="time"` for an
 * epoch-ms x (calls over time, p95 over time): the domain is the data's real min/max, never
 * forced to include 0, and ticks align to calendar steps instead of 1970-era numeric ones.
 */
export function LineChart({
  series,
  width,
  height = 220,
  area = false,
  xFormat = String,
  yFormat = String,
  yMax,
  xScale = 'linear',
}: {
  series: readonly LineSeries[];
  width: number;
  height?: number;
  area?: boolean;
  xFormat?: (value: number) => string;
  yFormat?: (value: number) => string;
  yMax?: number;
  xScale?: 'linear' | 'time';
}) {
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = Math.max(1, height - MARGIN.top - MARGIN.bottom);
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const xDomain: [number, number] = xs.length > 0 ? [Math.min(...xs), Math.max(...xs)] : [0, 1];
  const yDomain: [number, number] = [0, yMax ?? Math.max(1, ...ys)];
  const x = linearScale(xDomain, [0, plotWidth]);
  const y = linearScale(yDomain, [plotHeight, 0]);
  const tooltipWidth = hover ? hover.label.length * 6 + 12 : 0;
  const tooltipOverflow = hover ? hover.x + 6 + tooltipWidth > plotWidth : false;

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
        <XAxis
          domain={xDomain}
          scale={x}
          y={plotHeight}
          format={xFormat}
          mode={xScale}
          width={plotWidth}
        />
        {series.map((s, seriesIndex) => {
          const color = CHART_PALETTE[seriesIndex % CHART_PALETTE.length];
          if (!s.band?.length) return null;
          const bandTop = s.band.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x)},${y(p.high)}`);
          const bandBottom = [...s.band].reverse().map((p) => `L${x(p.x)},${y(p.low)}`);
          return (
            <path
              key={`${s.key}-band`}
              d={`${bandTop.join(' ')} ${bandBottom.join(' ')} Z`}
              fill={color}
              opacity={0.1}
              stroke="none"
            />
          );
        })}
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
            {/* Anchor the tooltip from the left of the point once it would otherwise overflow
                the plot's right edge, rather than always growing rightward off-chart. */}
            <rect
              x={tooltipOverflow ? -(tooltipWidth + 6) : 6}
              y={-20}
              width={tooltipWidth}
              height={18}
              rx={4}
            />
            <text x={tooltipOverflow ? -tooltipWidth : 12} y={-7}>
              {hover.label}
            </text>
          </g>
        )}
      </g>
    </svg>
  );
}
