import { describe, expect, it } from 'vitest';
import {
  RoutingChange,
  RoutingReleaseSnapshot,
  routingDiff,
  type RoutingChange as Change,
} from '../src/index.ts';
import {
  POOL_SALES,
  SALES_HI_RELEASE,
  draft,
  draftInput,
  snapshot,
  snapshotInput,
} from './routing-fixture.ts';
import { transferInput } from './transfer-fixture.ts';
import { queueSnapshotInput } from './human-queue-fixture.ts';

const keys = (changes: Change[]) => changes.map((c) => `${c.area}:${c.op}:${c.key}`);
const edited = (patch: (input: Record<string, any>) => void) => draft(patch);

describe('routingDiff on drafts', () => {
  it('finds nothing between equal drafts, and is deterministic', () => {
    expect(routingDiff(draft(), draft())).toEqual([]);
    const after = edited((d) => (d.name = 'Renamed'));
    expect(routingDiff(draft(), after)).toEqual(routingDiff(draft(), after));
  });

  it('every change satisfies the wire schema', () => {
    const after = edited((d) => {
      d.name = 'Other';
      d.nodes[0].branches.push({
        key: 'extra',
        description: 'More',
        target: { kind: 'end', line: { en: 'Bye' } },
      });
    });
    for (const change of routingDiff(draft(), after))
      expect(RoutingChange.safeParse(change).success).toBe(true);
  });

  it('reports everything as added when there is no before', () => {
    const found = routingDiff(undefined, draft());
    expect(keys(found)).toEqual([
      'point:added:routing point',
      'node:added:node intent',
      `pool:added:pool ${POOL_SALES}`,
      expect.stringContaining('pool:added:pool 2222'),
    ]);
  });

  it('point: name, description, root, router, default target', () => {
    const after = edited((d) => {
      d.name = 'New name';
      d.description = 'Why';
      d.router.agentId = 'other-router';
      d.defaultTarget.release = { kind: 'pinned', releaseId: SALES_HI_RELEASE };
    });
    const found = routingDiff(draft(), after);
    expect(keys(found)).toEqual([
      'point:changed:name',
      'point:changed:description',
      'agent:changed:router',
      'agent:changed:defaultTarget',
    ]);
    expect(found[0]!.summary).toBe('Name changed from "Main line" to "New name"');
    expect(found[2]!.summary).toBe('Router agent changed from front-desk to other-router');
    expect(found[3]!.summary).toBe('Default target sales-en release changed');
  });

  it('languages and lines', () => {
    const after = edited((d) => {
      d.language.allowed = ['en', 'ta'];
      d.greeting = { en: 'Hello', hi: 'नमस्ते' };
      d.connecting = { en: 'One moment' };
      d.idle = { timeoutMs: 8000, prompts: [{ en: 'Still there?' }] };
    });
    const before = edited((d) => (d.language.allowed = ['en', 'hi', 'ta']));
    const found = routingDiff(before, after);
    expect(found.map((c) => c.summary)).toEqual([
      'Allowed languages: removed hi',
      'Greeting changed (en, hi)',
      'Connecting line added',
      'Idle prompts changed',
    ]);
  });

  it('limits', () => {
    const found = routingDiff(
      draft(),
      edited((d) => (d.limits = { maxTurns: 3, maxRouteSeconds: 90 })),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      area: 'limits',
      summary: 'Routing limits changed (maxTurns)',
    });
  });

  it('nodes: added, removed, changed scalar fields', () => {
    const extra = {
      id: 'billing',
      ask: { en: 'Billing?' },
      engines: [{ kind: 'llm', instructions: 'x' }],
      branches: [{ key: 'go', description: 'Go', target: { kind: 'end', line: { en: 'Bye' } } }],
      fallback: [{ kind: 'end', line: { en: 'Bye' } }],
    };
    const withExtra = edited((d) => d.nodes.push(extra));
    expect(keys(routingDiff(draft(), withExtra))).toEqual(['node:added:node billing']);
    expect(keys(routingDiff(withExtra, draft()))).toEqual(['node:removed:node billing']);
    const asked = edited((d) => (d.nodes[0].ask = { en: 'What do you need?' }));
    expect(routingDiff(draft(), asked)[0]!.summary).toBe('Node intent changed (ask)');
  });

  it('branches: added, removed, changed', () => {
    const before = draft();
    const added = edited((d) =>
      d.nodes[0].branches.push({
        key: 'billing',
        description: 'Bills',
        target: { kind: 'end', line: { en: 'Bye' } },
      }),
    );
    expect(routingDiff(before, added).map((c) => c.summary)).toEqual([
      'Branch billing added to node intent',
    ]);
    expect(routingDiff(added, before).map((c) => c.summary)).toEqual([
      'Branch billing removed from node intent',
    ]);
    const changed = edited((d) => (d.nodes[0].branches[0].description = 'Buying'));
    expect(routingDiff(before, changed).map((c) => c.summary)).toEqual([
      'Branch sales of node intent changed (description)',
    ]);
  });

  it('engines and fallback steps are compared by position', () => {
    const base = draft();
    const threshold = edited((d) => (d.nodes[0].engines[1].threshold = 0.9));
    expect(routingDiff(base, threshold).map((c) => c.summary)).toEqual([
      'Engine 2 of node intent changed (llm: threshold)',
    ]);
    const swapped = edited(
      (d) => (d.nodes[0].engines[1] = { kind: 'decision', instructions: 'Choose.' }),
    );
    expect(routingDiff(base, swapped).map((c) => c.summary)).toEqual([
      'Engine 2 of node intent changed (llm to decision)',
    ]);
    const fewer = edited((d) => d.nodes[0].engines.pop());
    expect(routingDiff(base, fewer).map((c) => c.summary)).toEqual([
      'Engine 2 (llm) removed from node intent',
    ]);
    const fallback = edited((d) =>
      d.nodes[0].fallback.splice(1, 0, { kind: 'callback', inMinutes: 30, line: { en: 'Bye' } }),
    );
    expect(routingDiff(base, fallback).map((c) => `${c.area}:${c.op}`)).toEqual([
      'fallback:changed',
      'fallback:changed',
      'fallback:added',
    ]);
  });

  it('transfer catalogue: added, target changes, hold changes, limits', () => {
    const withTransfer = transferDraft();
    expect(routingDiff(draft(), withTransfer).map((c) => c.summary)).toContain(
      'Transfer catalogue added',
    );
    expect(routingDiff(withTransfer, draft()).map((c) => c.summary)).toContain(
      'Transfer catalogue removed',
    );
    const changed = transferDraft((t) => {
      t.targets[2].confirm = 'never';
      t.targets[0].hold.maxSeconds = 60;
      t.targets.push({
        key: 'new',
        description: 'New',
        destination: { kind: 'node', node: 'intent' },
      });
      t.targets.splice(3, 1);
      t.limits = { maxTransfers: 5 };
      t.hold.maxSeconds = 90;
    });
    expect(routingDiff(withTransfer, changed).map((c) => c.summary)).toEqual([
      'Transfer limits changed (maxTransfers)',
      'Point hold policy changed',
      'Hold of transfer target support changed',
      'Transfer target senior changed (confirm)',
      'Transfer target new added',
      'Transfer target billing removed',
    ]);
  });
});

function transferDraft(patch: (transfer: Record<string, any>) => void = () => {}) {
  const transfer = transferInput();
  patch(transfer);
  return draft((d) => (d.transfer = transfer));
}

describe('routingDiff on snapshots', () => {
  it('compares pool members, pins and version between snapshots', () => {
    const before = snapshot();
    const input = snapshotInput();
    input.pools[POOL_SALES].version = 2;
    input.pools[POOL_SALES].members[1].priority = 90;
    input.pools[POOL_SALES].members.push({
      id: 'sales-ta',
      agent: { agentId: 'sales-ta', release: { kind: 'pinned', releaseId: SALES_HI_RELEASE } },
      languages: ['ta'],
    });
    input.pools[POOL_SALES].members.splice(0, 1);
    input.defaultTarget.release.releaseId = SALES_HI_RELEASE;
    const after = RoutingReleaseSnapshot.parse(input);
    expect(routingDiff(before, after).map((c) => c.summary)).toEqual([
      'Default target sales-en release changed',
      'Member sales-hi of pool Sales changed (priority)',
      'Member sales-ta added to pool Sales',
      'Member sales-en removed from pool Sales',
    ]);
  });

  it('adds and removes whole pools', () => {
    const before = snapshot();
    const input = snapshotInput();
    delete input.pools['22222222-2222-4222-8222-222222222222'];
    input.nodes[0].branches[1].target = { kind: 'end', line: { en: 'Bye' } };
    const after = RoutingReleaseSnapshot.parse(input);
    const found = routingDiff(before, after);
    expect(keys(found)).toContain('pool:removed:pool Support');
    expect(keys(routingDiff(after, before))).toContain('pool:added:pool Support');
  });

  it('a draft against a snapshot ignores pins but sees real changes', () => {
    const before = snapshot();
    const same = draft();
    expect(routingDiff(before, same).filter((c) => c.area !== 'pool')).toEqual([]);
    const renamed = edited((d) => (d.name = 'Renamed'));
    expect(keys(routingDiff(before, renamed))).toEqual(['point:changed:name']);
    const otherAgent = edited((d) => (d.defaultTarget.agentId = 'someone-else'));
    expect(keys(routingDiff(before, otherAgent))).toEqual(['agent:changed:defaultTarget']);
  });

  it('human queue bindings and pinned queue definitions', () => {
    const before = RoutingReleaseSnapshot.parse(queueSnapshotInput());
    const input = queueSnapshotInput();
    input.queues[Object.keys(input.queues)[0]!].version = 3;
    input.humanQueues[1].priority = 4;
    input.queues[Object.keys(input.queues)[1]!].priority = 4;
    const after = RoutingReleaseSnapshot.parse(input);
    const found = routingDiff(before, after).filter((c) => c.area === 'queue');
    expect(found.map((c) => c.summary)).toEqual([
      'Human queue support-desk definition changed (v2 to v3)',
      'Human queue floor binding changed (priority)',
    ]);
  });
});
