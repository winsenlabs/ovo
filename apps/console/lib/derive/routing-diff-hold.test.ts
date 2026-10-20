import { describe, expect, it } from 'vitest';
import { routingDiff } from './routing-diff';
import { groupChanges } from './routing-diff-groups';
import { holdTimeline } from './routing-hold';
import { layoutMap } from './routing-map';
import { sampleDraft } from './routing-support.test-helpers';
import { treeItems, treeNeighbour } from './routing-tree';

describe('routingDiff', () => {
  it('is empty for equal drafts and deterministic', () => {
    expect(routingDiff(sampleDraft(), sampleDraft())).toEqual([]);
  });
  it('reports added, removed and changed parts by area', () => {
    const before = sampleDraft();
    const after = sampleDraft();
    after.name = 'Renamed';
    after.nodes[0]!.ask = { en: 'Different?' };
    after.nodes[0]!.branches.pop();
    after.nodes.push({ ...after.nodes[1]!, id: 'extra' });
    after.transfer!.targets.shift();
    after.humanQueues = [];
    const changes = routingDiff(before, after);
    const summaries = changes.map((c) => c.summary);
    expect(summaries).toContain('The name changed');
    expect(summaries).toContain('Added node extra');
    expect(summaries).toContain('Removed branch intent > person');
    expect(summaries).toContain('Removed transfer target billing');
    expect(summaries).toContain('Removed queue binding desk');
    expect(groupChanges(changes).map((g) => g.area)).toEqual([
      'point',
      'node',
      'branch',
      'transfer',
      'queue',
    ]);
    expect(routingDiff(before, after)).toEqual(changes);
  });
  it('treats a missing before as all adds and diffs pinned pools', () => {
    expect(routingDiff(undefined, sampleDraft()).map((c) => c.op)).toEqual([
      'added',
      'added',
      'added',
    ]);
    const a = { ...sampleDraft(), pools: { p: { name: 'Sales', members: [{ id: 'a' }] } } };
    const b = {
      ...sampleDraft(),
      pools: { p: { name: 'Sales', members: [{ id: 'a' }, { id: 'b' }] } },
    };
    expect(routingDiff(a, b).map((c) => c.summary)).toEqual(['Added pool Sales / member b']);
  });
});

describe('holdTimeline', () => {
  const base = {
    loopFrom: 0,
    maxSeconds: 20,
    waitForCapacity: false,
    onTimeout: [{ kind: 'default' as const }],
  };
  it('plays the steps then loops from loopFrom and cuts at the maximum', () => {
    const { segments, timeoutAt } = holdTimeline({
      ...base,
      steps: [
        { kind: 'silence', seconds: 3 },
        { kind: 'line', line: { en: 'x' } },
      ],
      loopFrom: 1,
    });
    expect(segments.map((s) => [s.kind, s.fromS, s.toS, s.loop])).toEqual([
      ['silence', 0, 3, 0],
      ['line', 3, 7, 0],
      ['line', 7, 11, 1],
      ['line', 11, 15, 2],
      ['line', 15, 19, 3],
      ['line', 19, 20, 4],
    ]);
    expect(timeoutAt).toBe(20);
  });
  it('uses real clip lengths, cuts a clip at its own limit and labels unknown ones', () => {
    const known = holdTimeline(
      { ...base, steps: [{ kind: 'clip', assetId: 'a', maxSeconds: 5 }], maxSeconds: 12 },
      { clipSeconds: () => 30 },
    );
    expect(known.segments.map((s) => [s.fromS, s.toS])).toEqual([
      [0, 5],
      [5, 10],
      [10, 12],
    ]);
    expect(
      holdTimeline({ ...base, steps: [{ kind: 'clip', assetId: 'a' }] }).segments[0]!.label,
    ).toContain('unknown');
  });
});

describe('tree and map layout', () => {
  it('lists node, branch and child rows in reading order, collapsing and flagging repeats', () => {
    const d = sampleDraft();
    const items = treeItems(d, new Set());
    expect(items.map((i) => i.key)).toEqual([
      'n:intent',
      'b:intent:sales',
      'b:intent:support',
      'n:support_kind',
      'b:support_kind:billing',
      'b:support_kind:other',
      'b:intent:person',
    ]);
    expect(items.find((i) => i.key === 'n:support_kind')).toMatchObject({
      level: 3,
      parentKey: 'b:intent:support',
    });
    expect(treeItems(d, new Set(['n:intent'])).map((i) => i.key)).toEqual(['n:intent']);
    d.nodes[0]!.branches[0] = { key: 'sales', description: 'x', next: 'support_kind' };
    expect(
      treeItems(d, new Set())
        .filter((i) => i.nodeId === 'support_kind' && i.kind === 'node')
        .map((i) => i.repeated),
    ).toEqual([false, true]);
  });
  it('moves focus by key and stays put at the ends', () => {
    const items = treeItems(sampleDraft(), new Set());
    expect(treeNeighbour(items, 'n:intent', 'ArrowDown')).toBe('b:intent:sales');
    expect(treeNeighbour(items, 'n:intent', 'ArrowUp')).toBe('n:intent');
    expect(treeNeighbour(items, 'n:intent', 'End')).toBe('b:intent:person');
    expect(treeNeighbour(items, 'b:intent:person', 'Home')).toBe('n:intent');
  });
  it('draws every node once, a pill per destination and an edge per branch', () => {
    const map = layoutMap(sampleDraft());
    expect(map.boxes.filter((b) => b.kind === 'node')).toHaveLength(2);
    expect(map.boxes.filter((b) => b.kind === 'target')).toHaveLength(4);
    expect(map.edges).toHaveLength(5);
    expect(map.width).toBeGreaterThan(0);
    const unreachable = sampleDraft();
    unreachable.nodes[0]!.branches[1] = {
      key: 'support',
      description: 'x',
      target: { kind: 'end', line: { en: 'bye' } },
    };
    expect(layoutMap(unreachable).boxes.filter((b) => b.kind === 'node')).toHaveLength(2);
  });
});
