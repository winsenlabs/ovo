// Legacy primitive set, kept so every pre-W14 screen that still imports from here keeps
// rendering exactly as before (props differ from the W14 equivalents below, so this file is not
// simply re-exported: `StatusBadge`'s tone enum is 'good'/'warning'/'soft', not the shared
// `lib/status.ts` tone map; `EmptyState` has no variant; `ResponsiveTable`/`JsonEvidence` have no
// sort, selection or collapse). Do not add new call sites — build against `components/ui/*`
// instead. Migration map, old -> new:
//   Panel / PanelHeader       -> components/ui/section-card.tsx  SectionCard
//   StatusBadge               -> components/ui/status-badge.tsx  StatusBadgeV2
//   Field                     -> components/ui/form-field.tsx    FormField
//   EmptyState                -> components/ui/feedback-v2.tsx   EmptyStateV2
//   Notice                    -> components/ui/feedback-v2.tsx   InlineAlert
//   LoadingBlock              -> components/ui/feedback-v2.tsx   Skeleton
//   ResponsiveTable           -> components/ui/data-table-v2.tsx DataTableV2
//   JsonEvidence              -> components/ui/code-block.tsx    CodeBlock / JsonViewer
import { Children, cloneElement, isValidElement, type ReactNode } from 'react';

/** @deprecated Use `SectionCard` from `components/ui/section-card.tsx` on new screens. */
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

/** @deprecated Use `SectionCard`'s `title`/`actions` props instead. */
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

/**
 * @deprecated Use `StatusBadgeV2` from `components/ui/status-badge.tsx`, which sources its tone
 * from the shared `lib/status.ts` map instead of a caller-chosen tone (today's bug class: this
 * version lets a screen pass `tone="good"` for `running`, when the shared map says `info`).
 */
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

/** @deprecated Use `FormField` from `components/ui/form-field.tsx` on new screens. */
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
      {children && (
        <div data-field-control>
          {Children.map(children, (child) =>
            isValidElement<Record<string, unknown>>(child)
              ? cloneElement(child, {
                  'aria-describedby': describedBy,
                  'aria-invalid': error ? true : undefined,
                })
              : child,
          )}
        </div>
      )}
      {help && <small id={`${htmlFor}-help`}>{help}</small>}
      {error && (
        <small className="field-error" id={`${htmlFor}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

/** @deprecated Use `EmptyStateV2` from `components/ui/feedback-v2.tsx`, which adds the
 * first-run/filtered/unavailable variants this version does not have. */
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

/** @deprecated Use `InlineAlert` from `components/ui/feedback-v2.tsx` on new screens. */
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

/** @deprecated Use `Skeleton` from `components/ui/feedback-v2.tsx` on new screens. */
export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}…
    </div>
  );
}

/** @deprecated Use `DataTableV2` from `components/ui/data-table-v2.tsx`, which adds sort,
 * selection and a loading/empty/error state this version does not have. */
export function ResponsiveTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-region" role="region" aria-label={label} tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

/** @deprecated Use `CodeBlock`/`JsonViewer` from `components/ui/code-block.tsx`, which collapse
 * by default and show a size label instead of always rendering the full payload open. */
export function JsonEvidence({ value, label }: { value: unknown; label: string }) {
  return (
    <details className="json-evidence">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
