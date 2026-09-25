'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { SessionIdentity } from '../../lib/api';
import { Sidebar } from './sidebar';

export function MobileNav({ identity }: { identity: SessionIdentity }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const path = usePathname();
  useEffect(() => {
    setOpen(false);
  }, [path]);
  useEffect(() => {
    const dialog = panel.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('a')?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
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
      <dialog
        id="mobile-navigation"
        ref={panel}
        className="mobile-nav-panel"
        aria-label="Navigation"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a')];
          if (event.shiftKey && document.activeElement === links[0]) {
            event.preventDefault();
            links.at(-1)?.focus();
          } else if (!event.shiftKey && document.activeElement === links.at(-1)) {
            event.preventDefault();
            links[0]?.focus();
          }
        }}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        <Sidebar identity={identity} onNavigate={() => setOpen(false)} />
      </dialog>
    </div>
  );
}
