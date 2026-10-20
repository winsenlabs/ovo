import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';

export interface TreeItem {
  /** Unique within the tree: `n:<node>` or `b:<path>`. */
  key: string;
  kind: 'node' | 'branch';
  nodeId: string;
  branchKey?: string;
  level: number;
  parentKey?: string;
  /** Has children to show (a node with branches, a branch leading to a question). */
  expandable: boolean;
  /** A question already shown higher up; this row only points at it and does not expand again. */
  repeated: boolean;
  posInSet: number;
  setSize: number;
}

/**
 * The tree as a flat reading order for `role="tree"`: a question, its branches, and under a branch
 * that leads to another question, that question. A question reached twice is shown once in full.
 * Questions nothing leads to follow, flagged by their own root-level rows.
 */
export function treeItems(draft: RoutingPointDraft, collapsed: ReadonlySet<string>): TreeItem[] {
  const byId = new Map(draft.nodes.map((n) => [n.id, n]));
  const placed = new Set<string>();
  const items: TreeItem[] = [];
  const addNode = (
    id: string,
    level: number,
    parentKey: string | undefined,
    pos: number,
    size: number,
    repeated: boolean,
  ) => {
    const node = byId.get(id);
    if (!node) return;
    const key = repeated ? `r:${parentKey}:${id}` : `n:${id}`;
    items.push({
      key,
      kind: 'node',
      nodeId: id,
      level,
      parentKey,
      expandable: !repeated && node.branches.length > 0,
      repeated,
      posInSet: pos,
      setSize: size,
    });
    if (repeated || collapsed.has(key)) return;
    placed.add(id);
    node.branches.forEach((branch, b) => {
      const bKey = `b:${id}:${branch.key}`;
      const next = branch.next !== undefined && byId.has(branch.next) ? branch.next : undefined;
      items.push({
        key: bKey,
        kind: 'branch',
        nodeId: id,
        branchKey: branch.key,
        level: level + 1,
        parentKey: key,
        expandable: next !== undefined,
        repeated: false,
        posInSet: b + 1,
        setSize: node.branches.length,
      });
      if (next && !collapsed.has(bKey)) addNode(next, level + 2, bKey, 1, 1, placed.has(next));
    });
  };
  addNode(draft.root, 1, undefined, 1, 1, false);
  // Reachability ignores collapsing: a hidden descendant is still part of the tree.
  const reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id) || !byId.has(id)) return;
    reachable.add(id);
    for (const branch of byId.get(id)!.branches) if (branch.next) walk(branch.next);
  };
  walk(draft.root);
  // Unreachable questions can lead to one another; only the head of such a chain is a root row,
  // the rest nest under it (a second root row would repeat the key). A pure cycle has no head, so
  // its first question stands in for one.
  const loose = draft.nodes.filter((n) => !reachable.has(n.id));
  const below = (id: string) => {
    const seen = new Set<string>();
    const visit = (from: string) => {
      for (const branch of byId.get(from)?.branches ?? [])
        if (branch.next && byId.has(branch.next) && !seen.has(branch.next)) {
          seen.add(branch.next);
          visit(branch.next);
        }
    };
    visit(id);
    return seen;
  };
  const reach = new Map(loose.map((n) => [n.id, below(n.id)]));
  const heads = loose.filter(
    (n) => !loose.some((o) => o.id !== n.id && reach.get(o.id)!.has(n.id)),
  );
  const covered = new Set(heads.flatMap((n) => [n.id, ...reach.get(n.id)!]));
  for (const node of loose) {
    if (covered.has(node.id)) continue;
    heads.push(node);
    covered.add(node.id);
    for (const id of reach.get(node.id)!) covered.add(id);
  }
  heads.forEach((node, i) => addNode(node.id, 1, undefined, i + 2, heads.length + 1, false));
  return items;
}

/** The item a key press moves to, or the same one when there is nowhere to go. */
export function treeNeighbour(
  items: readonly TreeItem[],
  current: string,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): string {
  const at = items.findIndex((i) => i.key === current);
  if (key === 'Home') return items[0]?.key ?? current;
  if (key === 'End') return items.at(-1)?.key ?? current;
  const next = key === 'ArrowDown' ? at + 1 : at - 1;
  return items[Math.min(Math.max(next, 0), items.length - 1)]?.key ?? current;
}
