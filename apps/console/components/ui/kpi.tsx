import type { ReactNode } from 'react';
import { Sparkline } from '../charts/sparkline';

export type KpiDelta = { value: number; label?: string; tone?: 'ok' | 'danger' | 'neutral' };

/**
 * One KPI tile: label, tabular value, optional unit/delta/sparkline/footnote, optional drill-in
 * link. Pass `loading` for the skeleton shape and `value={null}` for the "Unknown" dash state
 * (never render null as 0 — see brief §1.4).
 */
export function KpiCard({
  label,
  value,
  unit,
  delta,
  sparkline,
  footnote,
  href,
  loading = false,
}: {
  label: string;
  value?: ReactNode | null;
  unit?: string;
  delta?: KpiDelta;
  sparkline?: readonly number[];
  footnote?: ReactNode;
  href?: string;
  loading?: boolean;
}) {
  const body = (
    <article className="ds-kpi" aria-busy={loading || undefined}>
      <p className="ds-kpi-label">{label}</p>
      {loading ? (
        <span
          className="ds-skeleton ds-skeleton-kpi"
          role="status"
          aria-label={`Loading ${label}`}
        />
      ) : (
        <div className="ds-kpi-row">
          <span className="ds-kpi-value" title={value == null ? 'Unknown' : undefined}>
            {value == null ? '—' : value}
          </span>
          {unit && value != null && <span className="ds-kpi-unit">{unit}</span>}
          {sparkline && sparkline.length > 1 && (
            <Sparkline values={sparkline} className="ds-kpi-spark" />
          )}
        </div>
      )}
      {!loading && delta && (
        <span className={`ds-kpi-delta tone-${delta.tone ?? (delta.value >= 0 ? 'ok' : 'danger')}`}>
          <span aria-hidden="true">{delta.value >= 0 ? '▲' : '▼'}</span>
          {Math.abs(delta.value)}
          {delta.label ? ` ${delta.label}` : '%'}
        </span>
      )}
      {!loading && footnote && <small className="ds-kpi-footnote">{footnote}</small>}
    </article>
  );
  return href ? (
    <a href={href} className="ds-kpi-link" aria-label={`${label}: open detail`}>
      {body}
    </a>
  ) : (
    body
  );
}

/** 2–6 KPI cards, `repeat(auto-fit,minmax(180px,1fr))`, 2 columns at 390px via the shared CSS. */
export function KpiStrip({ children }: { children: ReactNode }) {
  return <div className="ds-kpi-strip">{children}</div>;
}
