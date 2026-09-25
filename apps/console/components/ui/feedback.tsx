import type { ReactNode } from 'react';
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden>
        ○
      </span>
      <strong>{title}</strong>
      <div>{children}</div>
      {action}
    </div>
  );
}
export function Callout({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}) {
  return (
    <div className={`notice ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
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
      <span className="status-mark" aria-hidden />
      {children}
    </span>
  );
}
export function Stat({
  label,
  value,
  description,
}: {
  label: string;
  value: ReactNode;
  description?: string;
}) {
  return (
    <div className="ui-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {description && <small>{description}</small>}
    </div>
  );
}
export function Skeleton({ label = 'Loading' }: { label?: string }) {
  return <span className="ui-skeleton" role="status" aria-label={label} />;
}
