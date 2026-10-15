// Pre-W14 primitive set, kept so existing screens keep rendering unchanged. Do not add new call
// sites — build against `feedback-v2.tsx` / `status-badge.tsx` instead:
//   EmptyState  -> feedback-v2.tsx   EmptyStateV2 (adds first-run/filtered/unavailable variants)
//   Callout     -> feedback-v2.tsx   InlineAlert
//   StatusBadge -> status-badge.tsx  StatusBadgeV2 (tone from the shared `lib/status.ts` map)
//   Skeleton    -> feedback-v2.tsx   Skeleton (shape-aware: text/line/block/table-row/kpi/chart)
import type { ReactNode } from 'react';
/** @deprecated Use `EmptyStateV2` from `./feedback-v2`. */
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
/** @deprecated Use `InlineAlert` from `./feedback-v2`. */
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
/** @deprecated Use `StatusBadgeV2` from `./status-badge`, sourced from the shared tone map. */
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
/** @deprecated Use `Skeleton` from `./feedback-v2`, which takes a `shape` matching the final
 * layout instead of one generic pulsing block. */
export function Skeleton({ label = 'Loading' }: { label?: string }) {
  return <span className="ui-skeleton" role="status" aria-label={label} />;
}
