import type { AddChange } from './diff-util.ts';
import { changedFields, indexBy, joinNames, same } from './diff-util.ts';
import type { RoutingNode } from './tree.ts';

function describeEngine(engine: RoutingNode['engines'][number]): string {
  return engine.kind;
}

/** Engines and fallback steps are ordered lists; compare by position. */
function diffOrdered<T extends { kind: string }>(
  add: AddChange,
  area: 'engine' | 'fallback',
  node: RoutingNode,
  nIndex: number,
  before: readonly T[],
  after: readonly T[],
): void {
  const label = area === 'engine' ? 'Engine' : 'Fallback step';
  const field = area === 'engine' ? 'engines' : 'fallback';
  for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
    const b = before[i];
    const a = after[i];
    const key = `node ${node.id} / ${area} ${i + 1}`;
    const path = ['nodes', nIndex, field, i];
    const kind = (item: T) => (area === 'engine' ? describeEngine(item as never) : item.kind);
    if (!b && a)
      add(area, 'added', key, path, `${label} ${i + 1} (${kind(a)}) added to node ${node.id}`, {
        after: a,
      });
    else if (b && !a)
      add(
        area,
        'removed',
        key,
        path,
        `${label} ${i + 1} (${kind(b)}) removed from node ${node.id}`,
        { before: b },
      );
    else if (b && a && !same(b, a)) {
      const what =
        b.kind === a.kind
          ? `${kind(a)}: ${joinNames(changedFields(b, a))}`
          : `${kind(b)} to ${kind(a)}`;
      add(area, 'changed', key, path, `${label} ${i + 1} of node ${node.id} changed (${what})`, {
        before: b,
        after: a,
      });
    }
  }
}

function diffNode(add: AddChange, before: RoutingNode, after: RoutingNode, n: number): void {
  const id = after.id;
  const scalars = changedFields(
    { sets: before.sets, ask: before.ask, reuseTurn: before.reuseTurn },
    { sets: after.sets, ask: after.ask, reuseTurn: after.reuseTurn },
  );
  if (scalars.length)
    add(
      'node',
      'changed',
      `node ${id}`,
      ['nodes', n],
      `Node ${id} changed (${joinNames(scalars)})`,
    );
  const branches = indexBy(before.branches, (b) => b.key);
  const next = indexBy(after.branches, (b) => b.key);
  for (const [key, { item, index }] of next) {
    const was = branches.get(key);
    const path = ['nodes', n, 'branches', index];
    const label = `node ${id} / branch ${key}`;
    if (!was)
      add('branch', 'added', label, path, `Branch ${key} added to node ${id}`, { after: item });
    else if (!same(was.item, item))
      add(
        'branch',
        'changed',
        label,
        path,
        `Branch ${key} of node ${id} changed (${joinNames(changedFields(was.item, item))})`,
        { before: was.item, after: item },
      );
  }
  for (const [key, { item, index }] of branches)
    if (!next.has(key))
      add(
        'branch',
        'removed',
        `node ${id} / branch ${key}`,
        ['nodes', n, 'branches', index],
        `Branch ${key} removed from node ${id}`,
        { before: item },
      );
  diffOrdered(add, 'engine', after, n, before.engines, after.engines);
  diffOrdered(add, 'fallback', after, n, before.fallback, after.fallback);
}

export function diffNodes(
  add: AddChange,
  before: readonly RoutingNode[],
  after: readonly RoutingNode[],
) {
  const was = indexBy(before, (node) => node.id);
  const now = indexBy(after, (node) => node.id);
  for (const [id, { item, index }] of now) {
    const old = was.get(id);
    if (!old)
      add('node', 'added', `node ${id}`, ['nodes', index], `Node ${id} added`, { after: item });
    else diffNode(add, old.item, item, index);
  }
  for (const [id, { item, index }] of was)
    if (!now.has(id))
      add('node', 'removed', `node ${id}`, ['nodes', index], `Node ${id} removed`, {
        before: item,
      });
}
