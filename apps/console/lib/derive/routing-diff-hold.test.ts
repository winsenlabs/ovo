import { describe, expect, it } from 'vitest';
import { routingDiff } from '@winsendotai/ovo-contracts';
import { AREA_ORDER, groupChanges } from './routing-diff-groups';
import { layoutMap } from './routing-map';
import { sampleDraft } from './routing-support.test-helpers';
import { treeItems, treeNeighbour } from './routing-tree';

describe('routingDiff in the console', () => {
  it('is the contract diff, grouped by area for the publish drawer', () => {
    expect(routingDiff(sampleDraft(), sampleDraft())).toEqual([]);
    const before = sampleDraft();
    const after = sampleDraft();
    after.name = 'Renamed';
    after.nodes[0]!.branches.pop();
    after.transfer!.targets.shift();
    after.humanQueues = [];
    const changes = routingDiff(before, after);
    expect(changes.length).toBeGreaterThan(0);
    expect(groupChanges(changes).map((g) => g.area)).toEqual(
      AREA_ORDER.filter((area) => changes.some((c) => c.area === area)),
    );
    expect(routingDiff(before, after)).toEqual(changes);
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
