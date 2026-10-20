import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import type { RoutingChange } from '../types/routing';
import {
  changedParts,
  field,
  keyed,
  nodeChanges,
  poolChanges,
  push,
  type Out,
} from './routing-diff-parts';

/** A draft, or a release snapshot (a draft plus pinned pools): both diff the same way. */
export type RoutingDiffInput = RoutingPointDraft & {
  pools?: Record<string, { name: string; members: { id: string }[] }>;
};

/** Compare two points or releases. Deterministic: same inputs, same list in the same order. */
export function routingDiff(
  before: RoutingDiffInput | undefined,
  after: RoutingDiffInput,
): RoutingChange[] {
  const out: Out = [];
  if (!before) {
    push(out, {
      area: 'point',
      op: 'added',
      key: 'point',
      path: [],
      summary: `New routing point ${after.name}`,
    });
    for (const node of after.nodes)
      push(out, {
        area: 'node',
        op: 'added',
        key: `node ${node.id}`,
        path: ['nodes', node.id],
        summary: `Added node ${node.id}`,
        after: node,
      });
    return out;
  }
  field(out, 'point', 'point', ['name'], 'The name', before.name, after.name);
  field(
    out,
    'point',
    'point',
    ['description'],
    'The description',
    before.description,
    after.description,
  );
  field(out, 'agent', 'router', ['router'], 'The router agent', before.router, after.router);
  field(
    out,
    'agent',
    'default target',
    ['defaultTarget'],
    'The default agent',
    before.defaultTarget,
    after.defaultTarget,
  );
  field(
    out,
    'language',
    'languages',
    ['language'],
    'The languages',
    before.language,
    after.language,
  );
  field(out, 'lines', 'greeting', ['greeting'], 'The greeting', before.greeting, after.greeting);
  field(
    out,
    'lines',
    'connecting',
    ['connecting'],
    'The connecting line',
    before.connecting,
    after.connecting,
  );
  field(out, 'lines', 'idle', ['idle'], 'The idle prompts', before.idle, after.idle);
  field(out, 'limits', 'limits', ['limits'], 'The router limits', before.limits, after.limits);
  field(out, 'node', 'root', ['root'], 'The first question', before.root, after.root);
  keyed(
    out,
    'node',
    'node',
    before.nodes,
    after.nodes,
    (n) => n.id,
    (n) => ['nodes', n.id],
    nodeChanges,
  );
  const transfer = (d: RoutingDiffInput) => d.transfer?.targets ?? [];
  keyed(
    out,
    'transfer',
    'transfer target',
    transfer(before),
    transfer(after),
    (t) => t.key,
    (t) => ['transfer', 'targets', t.key],
    (x, y, o) =>
      push(o, {
        area: 'transfer',
        op: 'changed',
        key: `transfer target ${y.key}`,
        path: ['transfer', 'targets', y.key],
        summary: `Transfer target ${y.key} changed (${changedParts(x, y)})`,
        before: x,
        after: y,
      }),
  );
  const { targets: _a, ...policyBefore } = before.transfer ?? { targets: [] };
  const { targets: _b, ...policyAfter } = after.transfer ?? { targets: [] };
  field(
    out,
    'hold',
    'transfer policy',
    ['transfer'],
    'The transfer policy (hold, limits, handover)',
    policyBefore,
    policyAfter,
  );
  keyed(
    out,
    'queue',
    'queue binding',
    before.humanQueues ?? [],
    after.humanQueues ?? [],
    (q) => q.key,
    (q) => ['humanQueues', q.key],
    (x, y, o) =>
      push(o, {
        area: 'queue',
        op: 'changed',
        key: `queue binding ${y.key}`,
        path: ['humanQueues', y.key],
        summary: `Queue binding ${y.key} changed`,
        before: x,
        after: y,
      }),
  );
  poolChanges(before, after, out);
  return out;
}
