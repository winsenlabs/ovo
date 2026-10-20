import { canonicalJson, type RoutingNode } from '@winsendotai/ovo-contracts';
import type { RoutingChange, RoutingChangeArea } from '../types/routing';
import type { RoutingDiffInput } from './routing-diff';

export const same = (a: unknown, b: unknown) =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);
export type Out = RoutingChange[];

export function push(out: Out, change: RoutingChange) {
  out.push(change);
}

/** Added / removed / changed entries of two keyed lists, in the order the "after" side lists them. */
export function keyed<T>(
  out: Out,
  area: RoutingChangeArea,
  label: string,
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
  path: (item: T, index: number) => (string | number)[],
  onChanged: (a: T, b: T, out: Out) => void,
) {
  const old = new Map(before.map((item) => [keyOf(item), item]));
  after.forEach((item, index) => {
    const key = keyOf(item);
    const previous = old.get(key);
    old.delete(key);
    if (!previous)
      push(out, {
        area,
        op: 'added',
        key: `${label} ${key}`,
        path: path(item, index),
        summary: `Added ${label} ${key}`,
        after: item,
      });
    else if (!same(previous, item)) onChanged(previous, item, out);
  });
  for (const [key, item] of old)
    push(out, {
      area,
      op: 'removed',
      key: `${label} ${key}`,
      path: path(item, 0),
      summary: `Removed ${label} ${key}`,
      before: item,
    });
}

export function field(
  out: Out,
  area: RoutingChangeArea,
  key: string,
  path: (string | number)[],
  what: string,
  a: unknown,
  b: unknown,
) {
  if (!same(a, b))
    push(out, { area, op: 'changed', key, path, summary: `${what} changed`, before: a, after: b });
}

export function nodeChanges(a: RoutingNode, b: RoutingNode, out: Out) {
  const key = `node ${b.id}`;
  const at = (...rest: (string | number)[]) => ['nodes', b.id, ...rest];
  field(out, 'node', key, at('ask'), `The question on ${b.id}`, a.ask, b.ask);
  field(out, 'node', key, at('sets'), `What ${b.id} sets`, a.sets, b.sets);
  field(
    out,
    'node',
    key,
    at('reuseTurn'),
    `Reuse of the caller's turn on ${b.id}`,
    a.reuseTurn,
    b.reuseTurn,
  );
  field(
    out,
    'engine',
    `${key} / engines`,
    at('engines'),
    `The engines on ${b.id}`,
    a.engines,
    b.engines,
  );
  field(
    out,
    'fallback',
    `${key} / fallback`,
    at('fallback'),
    `The fallback chain on ${b.id}`,
    a.fallback,
    b.fallback,
  );
  keyed(
    out,
    'branch',
    `branch ${b.id} >`,
    a.branches,
    b.branches,
    (x) => x.key,
    (x) => at('branches', x.key),
    (x, y, o) =>
      push(o, {
        area: 'branch',
        op: 'changed',
        key: `branch ${b.id} > ${y.key}`,
        path: at('branches', y.key),
        summary: `Branch ${b.id} > ${y.key} changed (${changedParts(x, y)})`,
        before: x,
        after: y,
      }),
  );
}

export function changedParts(x: Record<string, unknown>, y: Record<string, unknown>) {
  const parts = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(
    (k) => !same(x[k], y[k]),
  );
  return parts.join(', ') || 'details';
}

/** Compare two points or releases. Deterministic: same inputs, same list in the same order. */
export function poolChanges(before: RoutingDiffInput, after: RoutingDiffInput, out: Out) {
  if (!before.pools && !after.pools) return;
  const list = (d: RoutingDiffInput) =>
    Object.entries(d.pools ?? {}).map(([id, pool]) => ({ id, ...pool }));
  keyed(
    out,
    'pool',
    'pool',
    list(before),
    list(after),
    (p) => p.name,
    (p) => ['pools', p.id],
    (x, y, o) => {
      keyed(
        o,
        'member',
        `pool ${y.name} / member`,
        x.members,
        y.members,
        (m) => m.id,
        (m) => ['pools', y.id, 'members', m.id],
        (m1, m2, o2) =>
          push(o2, {
            area: 'member',
            op: 'changed',
            key: `pool ${y.name} / member ${m2.id}`,
            path: ['pools', y.id, 'members', m2.id],
            summary: `Member ${m2.id} of pool ${y.name} changed`,
            before: m1,
            after: m2,
          }),
      );
    },
  );
}
