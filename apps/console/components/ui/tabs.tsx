'use client';
import { useRef } from 'react';

export type TabItem = { id: string; label: string; disabled?: boolean };

function move(
  list: HTMLElement,
  from: number,
  delta: number,
  items: readonly TabItem[],
  onSelect: (id: string) => void,
) {
  const count = items.length;
  for (let step = 1; step <= count; step += 1) {
    const next = (from + delta * step + count) % count;
    if (!items[next].disabled) {
      onSelect(items[next].id);
      (list.children[next] as HTMLElement | undefined)?.focus();
      return;
    }
  }
}

/** WAI-ARIA tabs with roving tabindex and arrow-key navigation (brief §2 `Tabs`). */
export function Tabs({
  items,
  current,
  onSelect,
  panelId,
}: {
  items: readonly TabItem[];
  current: string;
  onSelect: (id: string) => void;
  panelId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === current),
  );
  return (
    <div
      role="tablist"
      className="ds-tabs"
      ref={ref}
      onKeyDown={(event) => {
        const list = ref.current;
        if (!list) return;
        if (event.key === 'ArrowRight') move(list, index, 1, items, onSelect);
        else if (event.key === 'ArrowLeft') move(list, index, -1, items, onSelect);
        else return;
        event.preventDefault();
      }}
    >
      {items.map((item, itemIndex) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`tab-${item.id}`}
          aria-selected={item.id === current}
          aria-controls={panelId}
          tabIndex={item.id === current ? 0 : -1}
          disabled={item.disabled}
          onClick={() => onSelect(item.id)}
          onFocus={() => itemIndex !== index && onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Route-backed tabs: real links with `aria-current`, for the agent sub-nav (Configure, Test…). */
export function LinkTabs({
  items,
}: {
  items: readonly { id: string; label: string; href: string; current: boolean }[];
}) {
  return (
    <nav className="ds-tabs ds-tabs-links" aria-label="Section">
      {items.map((item) => (
        <a key={item.id} href={item.href} aria-current={item.current ? 'page' : undefined}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
