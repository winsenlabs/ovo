import type { CSSProperties, ReactNode } from 'react';

/**
 * Replaces `Panel`/`PanelHeader` for new screens. Unlike `.panel`, this never sets
 * `overflow: hidden` — wide children (tables) scroll inside their own region instead of being
 * clipped (brief defect #2).
 */
export function SectionCard({
  title,
  description,
  actions,
  tabs,
  padding = 'data',
  footer,
  id,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  tabs?: ReactNode;
  padding?: 'data' | 'prose' | 'flush';
  footer?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className="ds-card" aria-labelledby={title ? headingId : undefined}>
      {(title || actions) && (
        <div className="ds-card-head">
          <div>
            {title && <h2 id={headingId}>{title}</h2>}
            {description && <p className="muted">{description}</p>}
          </div>
          {actions && <div className="ds-card-actions">{actions}</div>}
        </div>
      )}
      {tabs && <div className="ds-card-tabs">{tabs}</div>}
      <div className={`ds-card-body pad-${padding}`}>{children}</div>
      {footer && <div className="ds-card-footer">{footer}</div>}
    </section>
  );
}

/** `dl` with 2–4 responsive columns; values can be copyable mono via `copy`. */
export function KeyValueGrid({
  items,
  columns = 2,
}: {
  items: readonly { label: string; value: ReactNode; copy?: string; mono?: boolean }[];
  columns?: 2 | 3 | 4;
}) {
  return (
    <dl className="ds-kv" style={{ '--ds-kv-cols': columns } as CSSProperties}>
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? 'mono' : undefined}>
            {item.value == null || item.value === '' ? (
              <span className="ds-unknown">Unknown</span>
            ) : (
              item.value
            )}
            {item.copy && <CopyButton value={item.copy} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  return (
    <button
      type="button"
      className="ds-copy-button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => undefined);
      }}
      title={`${label}: ${value}`}
      aria-label={`${label} ${value}`}
    >
      <span aria-hidden="true">⧉</span>
    </button>
  );
}

/** Shortened mono id + copy + optional link, full id in the title tooltip. */
export function IdChip({ id, href, short }: { id: string; href?: string; short: string }) {
  const content = href ? (
    <a href={href} className="mono ds-id-text" title={id}>
      {short}
    </a>
  ) : (
    <span className="mono ds-id-text" title={id}>
      {short}
    </span>
  );
  return (
    <span className="ds-id-chip">
      {content}
      <CopyButton value={id} label="Copy id" />
    </span>
  );
}
