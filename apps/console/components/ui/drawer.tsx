'use client';
import type { ReactNode } from 'react';
import { Dialog } from './dialog';
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return <Dialog open={open} onClose={onClose} title={title} className="ui-drawer">
    <div className="ui-drawer-head"><button type="button" className="button" onClick={onClose}>Close</button></div>{children}
  </Dialog>;
}
