import type { ButtonHTMLAttributes, ReactNode } from 'react';
export function Button({
  variant = 'secondary',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  children: ReactNode;
}) {
  return (
    <button {...props} className={`button ${variant} ${props.className ?? ''}`}>
      {children}
    </button>
  );
}
/** @deprecated Use `Tabs` from `./tabs`, which adds WAI-ARIA roving-tabindex arrow-key
 * navigation this version does not have. */
export function Tabs({
  tabs,
  current,
  onSelect,
}: {
  tabs: readonly { id: string; label: string }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="tablist" className="ui-tabs">
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          key={tab.id}
          aria-selected={tab.id === current}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
/** @deprecated Use `RelativeTime` from `../../lib/format` + `./display.tsx`, which pins en-IN
 * and the installation's timezone instead of `toLocaleString()`'s browser-default locale (the
 * US-date-format defect this version still has). */
export function Time({ value }: { value?: string | null }) {
  if (!value) return <span>Time unavailable</span>;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (
    <span>Time unavailable</span>
  ) : (
    <time dateTime={value}>{date.toLocaleString()}</time>
  );
}
