import type { ReactNode } from 'react';

/** Mirrors `PageHeader`'s markup (`components/ui/layout.tsx`) but renders an `<h2>` instead of an
 * `<h1>`. Every `/agents/[id]/*` tab already sits under `AgentShell`'s own `<h1>` (the agent's
 * name) — Voice & plugins, Test and Releases each rendering a second page-level `<h1>` through
 * `PageHeader` gave every one of those tabs two top-level headings (brief: exactly one `<h1>` per
 * page). Overview and Configure already use their own markup with no second `<h1>`. */
export function SubPageHeader({
  title,
  eyebrow,
  description,
  actions,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ds-page-header">
      <div className="page-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        {actions && <div className="heading-actions">{actions}</div>}
      </div>
    </header>
  );
}
