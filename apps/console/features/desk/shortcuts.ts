'use client';
import { useEffect, useRef } from 'react';

export interface DeskShortcuts {
  accept: () => void;
  decline: () => void;
  mute: () => void;
  hangUp: () => void;
}

/**
 * A accepts, D declines, M mutes, H hangs up. Ignored while typing, with a modifier held, and
 * while a dialog is open (so the hang-up confirmation is not answered by a second H).
 */
export function useDeskShortcuts(handlers: DeskShortcuts): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, select, textarea, [contenteditable="true"]')
      )
        return;
      if (document.querySelector('dialog[open]')) return;
      const action = { a: 'accept', d: 'decline', m: 'mute', h: 'hangUp' }[event.key.toLowerCase()];
      if (!action) return;
      event.preventDefault();
      latest.current[action as keyof DeskShortcuts]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
