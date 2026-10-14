import type { ReactNode } from 'react';

export type SkeletonShape = 'text' | 'line' | 'block' | 'table-row' | 'kpi' | 'chart';

/** Matches the final layout's height so nothing shifts once data arrives (brief §1 motion rule). */
export function Skeleton({
  shape = 'line',
  width,
}: {
  shape?: SkeletonShape;
  width?: string | number;
}) {
  return (
    <span
      className={`ds-skeleton ds-skeleton-${shape}`}
      style={width != null ? { width } : undefined}
      role="status"
      aria-label="Loading"
    />
  );
}

export function SkeletonTableRows({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="ds-skeleton-table" role="status" aria-label="Loading rows">
      {Array.from({ length: rows }, (_, row) => (
        <div className="ds-skeleton-tr" key={row}>
          {Array.from({ length: columns }, (_, col) => (
            <Skeleton key={col} shape="table-row" />
          ))}
        </div>
      ))}
    </div>
  );
}

type EmptyVariant = 'first-run' | 'filtered' | 'unavailable';

/** `unavailable` is the honest 503 copy: "Not configured on this installation" + a docs pointer. */
export function EmptyStateV2({
  variant = 'first-run',
  title,
  children,
  action,
  secondaryHref,
  secondaryLabel,
}: {
  variant?: EmptyVariant;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  const icon = variant === 'unavailable' ? '⊘' : variant === 'filtered' ? '⌕' : '○';
  return (
    <div className={`ds-empty variant-${variant}`}>
      <span className="ds-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
      {action}
      {secondaryHref && (
        <a className="ds-empty-secondary" href={secondaryHref}>
          {secondaryLabel ?? 'Learn more'}
        </a>
      )}
    </div>
  );
}

/** Page-level 503/404: keeps the header visible, offers Retry and a request code for support. */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  requestCode,
  stillWorks,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  requestCode?: string;
  stillWorks?: string;
}) {
  return (
    <div className="ds-error-state" role="alert">
      <strong>{title}</strong>
      <p className="muted">{message}</p>
      {stillWorks && <p className="muted">{stillWorks}</p>}
      <div className="ds-error-actions">
        {onRetry && (
          <button type="button" className="button" onClick={onRetry}>
            Retry
          </button>
        )}
        {requestCode && <code className="mono muted">Request {requestCode}</code>}
      </div>
    </div>
  );
}

/** Compact inline variant for a single field/section rather than a whole page. */
export function InlineAlert({
  tone = 'danger',
  children,
  onRetry,
}: {
  tone?: 'warn' | 'danger' | 'info';
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className={`ds-inline-alert tone-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span>{children}</span>
      {onRetry && (
        <button type="button" className="text-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
