import { canonicalJson, type RoutingNode, type RoutingPointDraft } from '@winsendotai/ovo-contracts';
import type { RoutingChange, RoutingChangeArea } from '../types/routing';

/** A draft, or a release snapshot (a draft plus pinned pools): both diff the same way. */
export type RoutingDiffInput = RoutingPointDraft & {
  pools?: Record<string, { name: string; members: { id: string }[] }>;
};

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
type Out = RoutingChange[];

function push(out: Out, change: RoutingChange) {
  out.push(change);
}

/** Added / removed / changed entries of two keyed lists, in the order the "after" side lists them. */
function keyed<T>(
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
      push(out, { area, op: 'added', key: `${label} ${key}`, path: path(item, index), summary: `Added ${label} ${key}`, after: item });
    else if (!same(previous, item)) onChanged(previous, item, out);
  });
  for (const [key, item] of old)
    push(out, { area, op: 'removed', key: `${label} ${key}`, path: path(item, 0), summary: `Removed ${label} ${key}`, before: item });
}

function field(out: Out, area: RoutingChangeArea, key: string, path: (string | number)[], what: string, a: unknown, b: unknown) {
  if (!same(a, b))
    push(out, { area, op: 'changed', key, path, summary: `${what} changed`, before: a, after: b });
}

function nodeChanges(a: RoutingNode, b: RoutingNode, out: Out) {
  const key = `node ${b.id}`;
  const at = (...rest: (string | number)[]) => ['nodes', b.id, ...rest];
  field(out, 'node', key, at('ask'), `The question on ${b.id}`, a.ask, b.ask);
  field(out, 'node', key, at('sets'), `What ${b.id} sets`, a.sets, b.sets);
  field(out, 'node', key, at('reuseTurn'), `Reuse of the caller's turn on ${b.id}`, a.reuseTurn, b.reuseTurn);
  field(out, 'engine', `${key} / engines`, at('engines'), `The engines on ${b.id}`, a.engines, b.engines);
  field(out, 'fallback', `${key} / fallback`, at('fallback'), `The fallback chain on ${b.id}`, a.fallback, b.fallback);
  keyed(out, 'branch', `branch ${b.id} >`, a.branches, b.branches, (x) => x.key, (x) => at('branches', x.key), (x, y, o) =>
    push(o, {
      area: 'branch', op: 'changed', key: `branch ${b.id} > ${y.key}`, path: at('branches', y.key),
      summary: `Branch ${b.id} > ${y.key} changed (${changedParts(x, y)})`, before: x, after: y,
    }),
  );
}

function changedParts(x: Record<string, unknown>, y: Record<string, unknown>) {
  const parts = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !same(x[k], y[k]));
  return parts.join(', ') || 'details';
}

/** Compare two points or releases. Deterministic: same inputs, same list in the same order. */
export function routingDiff(before: RoutingDiffInput | undefined, after: RoutingDiffInput): RoutingChange[] {
  const out: Out = [];
  if (!before) {
    push(out, { area: 'point', op: 'added', key: 'point', path: [], summary: `New routing point ${after.name}` });
    for (const node of after.nodes)
      push(out, { area: 'node', op: 'added', key: `node ${node.id}`, path: ['nodes', node.id], summary: `Added node ${node.id}`, after: node });
    return out;
  }
  field(out, 'point', 'point', ['name'], 'The name', before.name, after.name);
  field(out, 'point', 'point', ['description'], 'The description', before.description, after.description);
  field(out, 'agent', 'router', ['router'], 'The router agent', before.router, after.router);
  field(out, 'agent', 'default target', ['defaultTarget'], 'The default agent', before.defaultTarget, after.defaultTarget);
  field(out, 'language', 'languages', ['language'], 'The languages', before.language, after.language);
  field(out, 'lines', 'greeting', ['greeting'], 'The greeting', before.greeting, after.greeting);
  field(out, 'lines', 'connecting', ['connecting'], 'The connecting line', before.connecting, after.connecting);
  field(out, 'lines', 'idle', ['idle'], 'The idle prompts', before.idle, after.idle);
  field(out, 'limits', 'limits', ['limits'], 'The router limits', before.limits, after.limits);
  field(out, 'node', 'root', ['root'], 'The first question', before.root, after.root);
  keyed(out, 'node', 'node', before.nodes, after.nodes, (n) => n.id, (n) => ['nodes', n.id], nodeChanges);
  const transfer = (d: RoutingDiffInput) => d.transfer?.targets ?? [];
  keyed(out, 'transfer', 'transfer target', transfer(before), transfer(after), (t) => t.key, (t) => ['transfer', 'targets', t.key], (x, y, o) =>
    push(o, { area: 'transfer', op: 'changed', key: `transfer target ${y.key}`, path: ['transfer', 'targets', y.key], summary: `Transfer target ${y.key} changed (${changedParts(x, y)})`, before: x, after: y }),
  );
  const { targets: _a, ...policyBefore } = before.transfer ?? { targets: [] };
  const { targets: _b, ...policyAfter } = after.transfer ?? { targets: [] };
  field(out, 'hold', 'transfer policy', ['transfer'], 'The transfer policy (hold, limits, handover)', policyBefore, policyAfter);
  keyed(out, 'queue', 'queue binding', before.humanQueues ?? [], after.humanQueues ?? [], (q) => q.key, (q) => ['humanQueues', q.key], (x, y, o) =>
    push(o, { area: 'queue', op: 'changed', key: `queue binding ${y.key}`, path: ['humanQueues', y.key], summary: `Queue binding ${y.key} changed`, before: x, after: y }),
  );
  poolChanges(before, after, out);
  return out;
}

function poolChanges(before: RoutingDiffInput, after: RoutingDiffInput, out: Out) {
  if (!before.pools && !after.pools) return;
  const list = (d: RoutingDiffInput) => Object.entries(d.pools ?? {}).map(([id, pool]) => ({ id, ...pool }));
  keyed(out, 'pool', 'pool', list(before), list(after), (p) => p.name, (p) => ['pools', p.id], (x, y, o) => {
    keyed(o, 'member', `pool ${y.name} / member`, x.members, y.members, (m) => m.id, (m) => ['pools', y.id, 'members', m.id], (m1, m2, o2) =>
      push(o2, { area: 'member', op: 'changed', key: `pool ${y.name} / member ${m2.id}`, path: ['pools', y.id, 'members', m2.id], summary: `Member ${m2.id} of pool ${y.name} changed`, before: m1, after: m2 }),
    );
  });
}

/** Changes grouped by area, in a stable reading order, for the publish drawer and release diff. */
export const AREA_ORDER: RoutingChangeArea[] = [
  'point', 'agent', 'language', 'lines', 'limits', 'node', 'branch', 'engine', 'fallback',
  'transfer', 'hold', 'queue', 'pool', 'member',
];
export const AREA_LABEL: Record<RoutingChangeArea, string> = {
  point: 'Point', agent: 'Agents', language: 'Languages', lines: 'Spoken lines', limits: 'Limits',
  node: 'Questions', branch: 'Branches', engine: 'Engines', fallback: 'Fallbacks',
  transfer: 'Transfers', hold: 'Hold', queue: 'Human queues', pool: 'Pools', member: 'Pool members',
};
export function groupChanges(changes: readonly RoutingChange[]) {
  return AREA_ORDER.map((area) => ({ area, label: AREA_LABEL[area], items: changes.filter((c) => c.area === area) })).filter((g) => g.items.length);
}
