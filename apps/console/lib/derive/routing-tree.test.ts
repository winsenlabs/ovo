import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { sampleDraft } from './routing-support.test-helpers';
import { treeItems } from './routing-tree';

type Node = RoutingPointDraft['nodes'][number];
const loose = (id: string, next?: string): Node => ({
  ...sampleDraft().nodes[1]!,
  id,
  branches: next ? [{ key: 'go', description: 'go', next }] : [],
});
const keys = (draft: RoutingPointDraft, collapsed = new Set<string>()) =>
  treeItems(draft, collapsed).map((i) => i.key);

describe('treeItems with unreachable questions', () => {
  it('nests a loose chain under its head so no key is emitted twice', () => {
    const d = sampleDraft();
    d.nodes.push(loose('loose_a', 'loose_b'), loose('loose_b'));
    const all = keys(d);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain('n:loose_a');
    expect(all).toContain('n:loose_b');
    const b = treeItems(d, new Set()).find((i) => i.key === 'n:loose_b')!;
    expect(b.parentKey).toBe('b:loose_a:go');
  });
  it('still reaches a chain whose tail is listed first', () => {
    const d = sampleDraft();
    d.nodes.push(loose('loose_b'), loose('loose_a', 'loose_b'));
    const all = keys(d);
    expect(new Set(all).size).toBe(all.length);
    expect(treeItems(d, new Set()).find((i) => i.key === 'n:loose_a')!.level).toBe(1);
  });
  it('shows a loose cycle once, from its first question', () => {
    const d = sampleDraft();
    d.nodes.push(loose('loose_a', 'loose_b'), loose('loose_b', 'loose_a'));
    const all = keys(d);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((k) => k.startsWith('n:loose_'))).toEqual(['n:loose_a', 'n:loose_b']);
  });
});
