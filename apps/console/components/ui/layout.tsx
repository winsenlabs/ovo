import type { ReactNode } from 'react';
type Props = { children: ReactNode; className?: string };
export function Stack({ children, className = '' }: Props) { return <div className={`ui-stack ${className}`}>{children}</div>; }
export function Cluster({ children, className = '' }: Props) { return <div className={`ui-cluster ${className}`}>{children}</div>; }
export function Grid({ children, className = '' }: Props) { return <div className={`ui-grid ${className}`}>{children}</div>; }
export function Panel({ children, className = '', labelledBy }: Props & { labelledBy?: string }) {
  return <section className={`panel ${className}`} aria-labelledby={labelledBy}>{children}</section>;
}
export function PanelHeader({ title, id, badge, children }: { title: string; id?: string; badge?: ReactNode; children?: ReactNode }) {
  return <div className="panel-head"><div><h2 id={id}>{title}</h2>{children}</div>{badge}</div>;
}
export function PanelBody({ children, className = '' }: Props) { return <div className={`panel-body ${className}`}>{children}</div>; }
export function PageHeader({ title, eyebrow, description, actions }: { title: string; eyebrow?: string; description?: string; actions?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{actions}</header>;
}
export function Toolbar({ children }: Props) { return <div className="ui-toolbar" role="toolbar">{children}</div>; }
