'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { SessionIdentity } from '../../lib/api';
import { Sidebar } from './sidebar';

/**
 * The mobile menu button + drawer. Renders `Sidebar` with `variant="mobile"`, which always lays
 * out full-width vertical groups — fixing brief defect #4, where the drawer used to inherit a
 * narrow-desktop CSS rule that turned the nav into a horizontal scroller and dropped the group
 * headings.
 */
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
        className="mobile-nav-trigger"
        aria-controls="mobile-navigation"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="mobile-nav-trigger-bars" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        Menu
      </button>
      <dialog
        id="mobile-navigation"
        ref={panel}
        className="mobile-nav-panel"
        aria-label="Navigation"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('a, button')];
          if (event.shiftKey && document.activeElement === focusable[0]) {
            event.preventDefault();
            focusable.at(-1)?.focus();
          } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
            event.preventDefault();
            focusable[0]?.focus();
          }
        }}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        {/* No brand lockup here — `Sidebar` renders its own "ovo" brand as the first thing
            inside the drawer, and duplicating it in this head bar doubled it on screen (brief
            defect #14). This bar exists only to host the close button. */}
        <div className="mobile-nav-head">
          <button
            type="button"
            className="mobile-nav-close"
            onClick={() => panel.current?.close()}
            aria-label="Close navigation"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <Sidebar identity={identity} onNavigate={() => panel.current?.close()} variant="mobile" />
      </dialog>
    </div>
  );
}
