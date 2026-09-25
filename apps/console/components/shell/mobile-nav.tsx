'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { SessionIdentity } from '../../lib/api';
import { Sidebar } from './sidebar';

export function MobileNav({ identity }: { identity: SessionIdentity }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const path = usePathname();
  useEffect(() => {
    setOpen(false);
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('a')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('a,button') ?? [])];
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      }
      if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (trigger.current ?? previous)?.focus();
    };
  }, [open]);
  return (
    <div className="mobile-nav">
      <button
        ref={trigger}
        type="button"
        className="button"
        aria-controls="mobile-navigation"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Menu
      </button>
      {open && (
        <>
          <button
            className="nav-scrim"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
          <div
            id="mobile-navigation"
            ref={panel}
            className="mobile-nav-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
          >
            <Sidebar identity={identity} onNavigate={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}
