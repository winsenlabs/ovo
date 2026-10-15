'use client';
import { Select } from '../ui/inputs';
import { SectionCard } from '../ui/section-card';
import { ErrorState, Skeleton } from '../ui/feedback-v2';
import {
  LOW_SAMPLE_THRESHOLD,
  type CompareBar,
  type CompareDimension,
} from '../../lib/derive/performance';
import { formatMsAxis } from '../charts/scale';
import styles from './performance-compare-panel.module.css';

const DIMENSIONS: { id: CompareDimension; label: string }[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'provider', label: 'Provider' },
  { id: 'model', label: 'Model' },
  { id: 'language', label: 'Language' },
  { id: 'release', label: 'Release' },
];

/**
 * "Compare by" grouped bar: p95 per cohort value for one dimension at a time. Hand-rolled rather
 * than the shared `BarChart` because a thin cohort (below {@link LOW_SAMPLE_THRESHOLD} samples)
 * must render greyed with its own warning — `BarChart` colours a whole series, not one bar, so it
 * cannot express per-category tone without a design-system change (noted as a foundation request
 * in the build report).
 */
export function PerformanceComparePanel({
  dimension,
  onDimensionChange,
  bars,
  loading,
  error,
  onRetry,
}: {
  dimension: CompareDimension;
  onDimensionChange: (dimension: CompareDimension) => void;
  bars: readonly CompareBar[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const max = Math.max(1, ...bars.map((bar) => bar.p95));
  return (
    <SectionCard
      title="Compare by"
      description={`p95 latency per cohort. Cohorts under ${LOW_SAMPLE_THRESHOLD} samples are flagged, never compared silently.`}
      actions={
        <div className="field" style={{ margin: 0, minWidth: 140 }}>
          <label htmlFor="compare-dimension" className="sr-only">
            Compare by
          </label>
          <Select
            id="compare-dimension"
            value={dimension}
            onChange={(value) => onDimensionChange(value as CompareDimension)}
            options={DIMENSIONS.map((item) => ({ value: item.id, label: item.label }))}
          />
        </div>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading ? (
        <Skeleton shape="chart" />
      ) : bars.length === 0 ? (
        <p className="muted">No cohorts matched for this dimension in range.</p>
      ) : (
        <ul className={styles.list} role="list" aria-label={`p95 latency by ${dimension}`}>
          {bars.slice(0, 12).map((bar) => (
            <li
              key={bar.category}
              className={bar.lowSample ? `${styles.row} ${styles.lowSample}` : styles.row}
            >
              <span className={styles.label} title={bar.category}>
                {bar.category}
              </span>
              <span
                className={styles.track}
                role="img"
                aria-label={`${bar.category}: ${formatMsAxis(bar.p95)} p95, ${bar.samples} samples${
                  bar.lowSample ? ', low sample size' : ''
                }`}
              >
                <span
                  className={styles.fill}
                  style={{ width: `${Math.max(2, (bar.p95 / max) * 100)}%` }}
                />
              </span>
              <span className={styles.value}>
                {formatMsAxis(bar.p95)}
                <small className="muted">
                  {' '}
                  · {bar.samples}
                  {bar.lowSample ? ' ⚠' : ''}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
