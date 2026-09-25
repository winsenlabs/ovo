import { Children, cloneElement, isValidElement, type ReactNode } from 'react';

export function Panel({
  children,
  className = '',
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section className={`panel ${className}`} aria-labelledby={labelledBy}>
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  id,
  badge,
  children,
}: {
  title: string;
  id?: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panel-head">
      <div>
        <h2 id={id}>{title}</h2>
        {children}
      </div>
      {badge}
    </div>
  );
}

export function StatusBadge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'good' | 'warning' | 'danger' | 'soft';
  children: ReactNode;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="status-mark" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  const describedBy =
    [help && `${htmlFor}-help`, error && `${htmlFor}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children && <div data-field-control>{Children.map(children, child =>
        isValidElement<Record<string, unknown>>(child)
          ? cloneElement(child, { 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })
          : child,
      )}</div>}
      {help && <small id={`${htmlFor}-help`}>{help}</small>}
      {error && (
        <small className="field-error" id={`${htmlFor}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        ○
      </span>
      <strong>{title}</strong>
      <div>{children}</div>
      {action}
    </div>
  );
}

export function Notice({
  tone = 'neutral',
  children,
  live = false,
}: {
  tone?: 'neutral' | 'warning' | 'danger';
  children: ReactNode;
  live?: boolean;
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === 'danger' ? 'alert' : undefined}
      aria-live={live ? 'polite' : undefined}
    >
      {children}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function ResponsiveTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-region" role="region" aria-label={label} tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

export function JsonEvidence({ value, label }: { value: unknown; label: string }) {
  return (
    <details className="json-evidence">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
