import type { ButtonHTMLAttributes, ReactNode } from 'react';
export function Button({ variant = 'secondary', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger'; children: ReactNode }) {
  return <button {...props} className={`button ${variant} ${props.className ?? ''}`}>{children}</button>;
}
export function Tabs({ tabs, current, onSelect }: { tabs: readonly { id: string; label: string }[]; current: string; onSelect: (id: string) => void }) {
  return <div role="tablist" className="ui-tabs">{tabs.map(tab => <button type="button" role="tab" key={tab.id} aria-selected={tab.id === current} onClick={() => onSelect(tab.id)}>{tab.label}</button>)}</div>;
}
export function Time({ value }: { value?: string | null }) {
  if (!value) return <span>Time unavailable</span>;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? <span>Time unavailable</span> : <time dateTime={value}>{date.toLocaleString()}</time>;
}
