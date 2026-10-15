const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export type HeatCell = { day: number; hour: number; value: number };

/** Optional hour x day call-volume heat map. Intensity runs `--accent-soft` to `--accent`. */
export function HeatStrip({
  cells,
  cellSize = 14,
}: {
  cells: readonly HeatCell[];
  cellSize?: number;
}) {
  const max = Math.max(1, ...cells.map((c) => c.value));
  const lookup = new Map(cells.map((cell) => [`${cell.day}-${cell.hour}`, cell.value]));
  const rowLabelWidth = 36;
  const hourLabelHeight = 14;
  const width = 24 * cellSize + rowLabelWidth;
  const height = 7 * cellSize + hourLabelHeight;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Call volume by hour and day of week"
      // The brief's fixed 372px (24 * 14 + 36) overflows a 390px viewport once the page gutter
      // is subtracted; scale the mark down to its container instead of clipping it.
      style={{ maxWidth: '100%', height: 'auto' }}
    >
      {Array.from({ length: 8 }, (_, tick) => tick * 3).map((hour) => (
        <text
          key={hour}
          x={rowLabelWidth + hour * cellSize}
          y={hourLabelHeight - 4}
          textAnchor="start"
          className="ds-chart-row-label"
        >
          {String(hour).padStart(2, '0')}:00
        </text>
      ))}
      {DAYS.map((label, day) => (
        <g key={label} transform={`translate(0,${hourLabelHeight + day * cellSize})`}>
          <text x={0} y={cellSize / 2} dy="0.32em" className="ds-chart-row-label">
            {label}
          </text>
          {Array.from({ length: 24 }, (_, hour) => {
            const value = lookup.get(`${day}-${hour}`) ?? 0;
            const intensity = value / max;
            return (
              <rect
                key={hour}
                x={rowLabelWidth + hour * cellSize}
                y={0}
                width={cellSize - 1}
                height={cellSize - 1}
                rx={2}
                fill="var(--accent)"
                opacity={value === 0 ? 0.06 : 0.15 + intensity * 0.85}
                role="img"
                aria-label={`${label} ${hour}:00 — ${value} calls`}
              />
            );
          })}
        </g>
      ))}
    </svg>
  );
}
