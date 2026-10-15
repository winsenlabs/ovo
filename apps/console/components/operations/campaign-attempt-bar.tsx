import { statusTone } from '../../lib/status';
import { campaignAttemptLabel } from '../../lib/derive/operations';

/**
 * A compact inline stacked bar for one campaign's `attempts[].status` tally, replacing the
 * "vertical stack of 4-5 badges per row" defect. `BarChart` (full axis, legend, margins sized for
 * a chart-sized region) does not fit a table cell, so this is a small local mark: segment widths
 * proportional to count, coloured by the shared status tone (never an arbitrary chart palette,
 * so "failed" is always the same red everywhere), the counts spelled out in the `title` tooltip
 * since colour alone never carries the only meaning.
 */
export function AttemptOutcomeBar({
  counts,
  width = 140,
  height = 10,
}: {
  counts: Record<string, number>;
  width?: number;
  height?: number;
}) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (!total || !entries.length) return <span className="ds-unknown">No attempts yet</span>;
  const summary = entries
    .map(([status, value]) => `${campaignAttemptLabel(status)}: ${value}`)
    .join(', ');
  let offset = 0;
  return (
    <span style={{ display: 'inline-grid', gap: 2 }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Attempt outcomes — ${summary}`}
        style={{ display: 'block' }}
      >
        <rect width={width} height={height} rx={height / 2} fill="var(--surface-2)" />
        {entries.map(([status, value]) => {
          const segmentWidth = (value / total) * width;
          const x = offset;
          offset += segmentWidth;
          return (
            <rect
              key={status}
              x={x}
              width={Math.max(1, segmentWidth)}
              height={height}
              fill={`var(--${statusTone(status)})`}
            />
          );
        })}
      </svg>
      <small className="muted" title={summary}>
        {entries.map(([status, value]) => `${campaignAttemptLabel(status)} ${value}`).join(' · ')}
      </small>
    </span>
  );
}
