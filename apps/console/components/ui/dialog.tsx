'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export function Dialog({ open, onClose, title, children, className = '' }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) { trigger.current = document.activeElement as HTMLElement; dialog.showModal(); }
    if (!open && dialog.open) { dialog.close(); trigger.current?.focus(); }
  }, [open]);
  return <dialog ref={ref} className={className} onClose={() => { onClose(); trigger.current?.focus(); }} aria-label={title}>
    <div className="ui-dialog"><h2>{title}</h2>{children}</div>
  </dialog>;
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', onChoice }: {
  open: boolean; title: string; message: string; confirmLabel?: string; onChoice: (value: boolean) => void;
}) {
  return <Dialog open={open} onClose={() => onChoice(false)} title={title}>
    <p>{message}</p><div className="ui-cluster">
      <button className="button" type="button" onClick={() => onChoice(false)}>Cancel</button>
      <button className="button danger" type="button" onClick={() => onChoice(true)}>{confirmLabel}</button>
    </div>
  </Dialog>;
}

export function useConfirmDialog() {
  const [request, setRequest] = useState<{ title: string; message: string; resolve: (value: boolean) => void }>();
  const confirm = useCallback((title: string, message: string) => new Promise<boolean>(resolve => {
    setRequest({ title, message, resolve });
  }), []);
  const choose = (value: boolean) => { request?.resolve(value); setRequest(undefined); };
  return {
    confirm,
    dialog: request ? <ConfirmDialog open title={request.title} message={request.message} onChoice={choose} /> : null,
  };
}

const ConfirmContext = createContext<((title: string, message: string) => Promise<boolean>) | null>(null);
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const { confirm, dialog } = useConfirmDialog();
  return <ConfirmContext.Provider value={confirm}>{children}{dialog}</ConfirmContext.Provider>;
}
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('Confirmation dialog unavailable');
  return confirm;
}
