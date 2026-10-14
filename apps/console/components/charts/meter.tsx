export type MeterSegment = {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
};

/**
 * Segmented progress bar (spent/reserved/available, worker capacity, quotas). `max` is the ceiling
 * the segments are drawn against; an optional `threshold` draws a marker line (e.g. the 3% abandon
 * breaker). Falls back to a single bar when only `value`/`max` are given.
 */
export function ProgressMeter({
  label,
  segments,
  value,
  max,
  threshold,
  tone,
  valueLabel,
}: {
  label: string;
  segments?: readonly MeterSegment[];
  value?: number;
  max: number;
  threshold?: number;
  tone?: 'ok' | 'warn' | 'danger';
  valueLabel?: string;
}) {
  const resolved = segments ?? (value != null ? [{ label, value, tone: tone ?? 'ok' }] : []);
  const spent = resolved.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const overspend = spent > max;
  // When the segments add up past `max` (e.g. 120 of a 100 budget), scale the track to the real
  // total instead of clamping fill width to 100%: a clamped bar silently hides the overspend
  // (brief defect: "overspend is clipped by the track's overflow:hidden, with no overspend
  // marker"). The `max` boundary itself is then drawn as a limit line so it stays legible.
  const total = Math.max(max, spent, 1);
  const describedValue = valueLabel ?? resolved.map((s) => `${s.label} ${s.value}`).join(', ');
  let offset = 0;
  return (
    <div className="ds-meter">
      <div className="ds-meter-head">
        <span>{label}</span>
        <span className="mono">{valueLabel}</span>
      </div>
      <div
        className="ds-meter-track"
        role="img"
        aria-label={`${label}: ${describedValue} of ${max}${overspend ? ' — over limit' : ''}`}
      >
        {resolved.map((segment, index) => {
          const width = (Math.max(0, segment.value) / total) * 100;
          const style = {
            width: `${width}%`,
            insetInlineStart: `${(offset / total) * 100}%`,
          };
          offset += segment.value;
          return (
            <span
              key={`${segment.label}-${index}`}
              className={`ds-meter-fill tone-${overspend ? 'danger' : (segment.tone ?? 'ok')}`}
              style={style}
              title={`${segment.label}: ${segment.value}`}
            />
          );
        })}
        {overspend && (
          <span
            className="ds-meter-threshold ds-meter-limit"
            style={{ insetInlineStart: `${(max / total) * 100}%` }}
            title={`Limit: ${max}`}
          />
        )}
        {threshold != null && (
          <span
            className="ds-meter-threshold"
            style={{ insetInlineStart: `${Math.min(100, (threshold / total) * 100)}%` }}
            title={`Threshold: ${threshold}`}
          />
        )}
      </div>
    </div>
  );
}
