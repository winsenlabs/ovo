import type { ReactNode } from 'react';
import { EmptyState, Panel, PanelHeader, StatusBadge } from '../primitives';

/** The shape every optional Configure section falls back to before it has anything saved: a
 * panel header with an amber "attention" badge, and an empty state whose call-to-action sits in
 * a real `action` slot instead of inline at the end of a paragraph (verifier: "empty-state CTA
 * buttons still sit inline at the end of paragraphs"; also "'Not configured' badges are green").
 * Extracted once several sections (`decision-start.tsx`, `recovery-editor.tsx`,
 * `knowledge-editor.tsx`, `rules-editor.tsx`) ended up repeating this near verbatim. */
export function UnconfiguredPanel({
  labelledBy,
  title,
  badgeLabel = 'Not configured',
  emptyTitle,
  action,
  children,
}: {
  labelledBy: string;
  title: string;
  badgeLabel?: string;
  emptyTitle: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel labelledBy={labelledBy}>
      <PanelHeader
        id={labelledBy}
        title={title}
        badge={<StatusBadge tone="warning">{badgeLabel}</StatusBadge>}
      />
      <div className="panel-body stack">
        <EmptyState title={emptyTitle} action={action}>
          {children}
        </EmptyState>
      </div>
    </Panel>
  );
}
