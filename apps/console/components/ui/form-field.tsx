import type { ReactNode } from 'react';
export type ControlProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true; required?: boolean };
export function FormField({ id, label, help, error, required, children }: {
  id: string; label: string; help?: string; error?: string; required?: boolean;
  children: (control: ControlProps) => ReactNode;
}) {
  const description = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return <div className="field"><label htmlFor={id}>{label}</label>
    {children({ id, 'aria-describedby': description, 'aria-invalid': error ? true : undefined, required })}
    {help && <small id={`${id}-help`}>{help}</small>}
    {error && <small id={`${id}-error`} className="field-error">{error}</small>}
  </div>;
}
