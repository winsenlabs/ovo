'use client';
import type { ReactNode } from 'react';
import { Drawer } from '../ui/drawer';

/** The shared drawer at the width tables need (segment detail, routing run detail). */
export function WideDrawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Drawer open={open} title={title} onClose={onClose}>
      <div className="route-wide-content">{children}</div>
    </Drawer>
  );
}
