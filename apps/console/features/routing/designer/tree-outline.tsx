'use client';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { treeItems, treeNeighbour, type TreeItem } from '../../../lib/derive/routing-tree';
import { ENGINE_LABEL, targetSummary } from '../../../lib/derive/routing-labels';
import type { AnchoredIssue } from '../../../lib/derive/routing-anchor';
import { useDesigner, useNames } from './designer-context';

const counts = (list: readonly AnchoredIssue[]) => ({
  errors: list.filter((a) => a.issue.severity === 'error').length,
  warnings: list.filter((a) => a.issue.severity === 'warning').length,
});

function Badges({ list }: { list: readonly AnchoredIssue[] }) {
  const { errors, warnings } = counts(list);
  return (
    <>
      {errors > 0 && (
        <StatusBadgeV2
          tone="danger"
          size="sm"
          label={`${errors} error${errors === 1 ? '' : 's'}`}
        />
      )}
      {warnings > 0 && (
        <StatusBadgeV2
          tone="warn"
          size="sm"
          label={`${warnings} warning${warnings === 1 ? '' : 's'}`}
        />
      )}
    </>
  );
}

/**
 * The questions as an accessible tree (`role="tree"`): arrow keys move, Right and Left open and
 * close a branch or step in and out, Enter opens the question's drawer. Nothing needs a pointer.
 */
export function TreeOutline({
  selected,
  onOpen,
}: {
  selected?: string;
  onOpen: (nodeId: string) => void;
}) {
  const { draft, index } = useDesigner();
  const names = useNames();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const items = useMemo(() => treeItems(draft, collapsed), [draft, collapsed]);
  const [focus, setFocus] = useState<string>();
  const refs = useRef(new Map<string, HTMLElement>());
  const current = items.some((i) => i.key === focus) ? focus! : items[0]?.key;
  const move = (key: string) => {
    setFocus(key);
    refs.current.get(key)?.focus();
  };
  const toggle = (key: string, open: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });

  function onKeyDown(event: KeyboardEvent, item: TreeItem) {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End')
      move(treeNeighbour(items, item.key, key));
    else if (key === 'ArrowRight') {
      if (!item.expandable) return;
      if (collapsed.has(item.key)) toggle(item.key, true);
      else {
        const child = items[items.findIndex((i) => i.key === item.key) + 1];
        if (child?.parentKey === item.key) move(child.key);
      }
    } else if (key === 'ArrowLeft') {
      if (item.expandable && !collapsed.has(item.key)) toggle(item.key, false);
      else if (item.parentKey) move(item.parentKey);
    } else if (key === 'Enter' || key === ' ') onOpen(item.nodeId);
    else return;
    event.preventDefault();
  }

  return (
    <div role="tree" aria-label="Questions and branches" className="rt-tree">
      {items.map((item) => {
        const node = draft.nodes.find((n) => n.id === item.nodeId)!;
        const branch = item.branchKey
          ? node.branches.find((b) => b.key === item.branchKey)
          : undefined;
        const issues =
          item.kind === 'node'
            ? (index.byNode.get(node.id) ?? []).filter((a) => a.anchor.section !== 'branch')
            : (index.byNode.get(node.id) ?? []).filter(
                (a) => a.anchor.section === 'branch' && a.anchor.branchKey === item.branchKey,
              );
        const label = item.kind === 'node' ? node.id : branch!.key;
        return (
          <div
            key={item.key}
            ref={(el) => void (el ? refs.current.set(item.key, el) : refs.current.delete(item.key))}
            role="treeitem"
            tabIndex={item.key === current ? 0 : -1}
            aria-level={item.level}
            aria-posinset={item.posInSet}
            aria-setsize={item.setSize}
            aria-expanded={item.expandable ? !collapsed.has(item.key) : undefined}
            aria-selected={item.kind === 'node' && item.nodeId === selected}
            className={`rt-tree-item rt-${item.kind}${item.nodeId === selected && item.kind === 'node' ? ' selected' : ''}`}
            style={{ paddingInlineStart: `calc(var(--space-3) + ${(item.level - 1) * 20}px)` }}
            onFocus={() => setFocus(item.key)}
            onKeyDown={(event) => onKeyDown(event, item)}
            onClick={() => onOpen(item.nodeId)}
          >
            {item.expandable && (
              <span
                className="rt-twisty"
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(item.key, collapsed.has(item.key));
                }}
              >
                {collapsed.has(item.key) ? '▸' : '▾'}
              </span>
            )}
            <span className="rt-tree-main">
              <strong className={item.kind === 'node' ? undefined : 'mono'}>{label}</strong>
              {item.kind === 'node' ? (
                <span className="muted rt-chips">
                  {draft.root === node.id && <span className="ds-chip">first question</span>}
                  {item.repeated && <span className="ds-chip">see above</span>}
                  {!item.repeated &&
                    node.engines.map((e, i) => (
                      <span key={i} className="ds-chip">
                        {ENGINE_LABEL[e.kind]}
                      </span>
                    ))}
                </span>
              ) : (
                <span className="muted">
                  {branch!.next !== undefined
                    ? `→ ${branch!.next}`
                    : `→ ${targetSummary(branch!.target!, names)}`}
                </span>
              )}
              <Badges list={issues} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
