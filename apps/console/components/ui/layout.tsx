'use client';
import type { ReactNode } from 'react';

export type Crumb = { label: string; href?: string };

/** Real route + entity trail ("Agents / EMI reminder / Plugins"), never just the nav label. */
export function Breadcrumb({ trail }: { trail: readonly Crumb[] }) {
  if (!trail.length) return null;
  return (
    <nav aria-label="Breadcrumb" className="ds-breadcrumb">
      <ol>
        {trail.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`}>
            {crumb.href && index < trail.length - 1 ? (
              <a href={crumb.href}>{crumb.label}</a>
            ) : (
              <span aria-current={index === trail.length - 1 ? 'page' : undefined}>
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The one page header. Exactly one `<h1>` per page. `meta` holds badges / last-refreshed; pass
 * `onRefresh` to render the refresh icon button next to it. Existing callers that only pass
 * title/eyebrow/description/actions keep rendering exactly as before.
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  breadcrumb,
  meta,
  onRefresh,
  refreshing = false,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: ReactNode;
  breadcrumb?: readonly Crumb[];
  meta?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <header className="ds-page-header">
      {breadcrumb && <Breadcrumb trail={breadcrumb} />}
      <div className="page-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {description && <p className="muted">{description}</p>}
        </div>
        {actions && <div className="heading-actions">{actions}</div>}
      </div>
      {(meta || onRefresh) && (
        <div className="ds-page-meta">
          {meta}
          {onRefresh && (
            <button
              type="button"
              className="ds-icon-button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label={refreshing ? 'Refreshing' : 'Refresh'}
              title={refreshing ? 'Refreshing…' : 'Refresh'}
            >
              <span aria-hidden="true" className={refreshing ? 'ds-spin' : undefined}>
                ↻
              </span>
            </button>
          )}
        </div>
      )}
    </header>
  );
}
