import { describe, expect, it } from 'vitest';
import { blankBranch, blankDraft, blankNode } from './routing-defaults';
import {
  addNode,
  deleteNode,
  moveStep,
  removeStep,
  renameBranch,
  renameNode,
  renameQueueKey,
} from './routing-edit';
import { sampleDraft } from './routing-support.test-helpers';

const ok = <T extends { draft?: unknown; error?: string }>(result: T) => {
  expect(result.error).toBeUndefined();
  return result.draft as ReturnType<typeof sampleDraft>;
};

describe('renameNode', () => {
  it('rewrites the root, branch next and transfer re-route targets', () => {
    const d = sampleDraft();
    d.transfer!.targets.push({
      key: 'back',
      description: 'x',
      destination: { kind: 'node', node: 'support_kind' },
    });
    const next = ok(renameNode(d, 'support_kind', 'support_type'));
    expect(next.nodes.map((n) => n.id)).toEqual(['intent', 'support_type']);
    expect(next.nodes[0]!.branches[1]!.next).toBe('support_type');
    expect(next.transfer!.targets.at(-1)!.destination).toEqual({
      kind: 'node',
      node: 'support_type',
    });
    expect(ok(renameNode(d, 'intent', 'start')).root).toBe('start');
  });
  it('refuses bad, taken and unknown ids', () => {
    const d = sampleDraft();
    expect(renameNode(d, 'intent', 'Not Valid')).toHaveProperty('error');
    expect(renameNode(d, 'intent', 'support_kind')).toHaveProperty('error');
    expect(renameNode(d, 'nope', 'x')).toHaveProperty('error');
    expect(renameNode(d, 'intent', 'intent')).toEqual({ draft: d });
  });
});

describe('deleteNode', () => {
  it('refuses the root and a node something still leads to, naming who', () => {
    const d = sampleDraft();
    expect(deleteNode(d, 'intent')).toHaveProperty(
      'error',
      expect.stringContaining('first question'),
    );
    expect(deleteNode(d, 'support_kind')).toHaveProperty(
      'error',
      expect.stringContaining('intent > support'),
    );
  });
  it('deletes a node nothing leads to', () => {
    const d = sampleDraft();
    d.nodes[0]!.branches[1] = blankBranch('support');
    expect(ok(deleteNode(d, 'support_kind')).nodes).toHaveLength(1);
  });
});

describe('addNode, renameBranch and list edits', () => {
  it('adds a unique valid node up to the limit', () => {
    const d = blankDraft({ name: 'x', routerAgentId: 'a', defaultAgentId: 'b' });
    expect(ok(addNode(d, blankNode('second'))).nodes).toHaveLength(2);
    expect(addNode(d, blankNode('start'))).toHaveProperty('error');
    expect(addNode(d, blankNode('Bad'))).toHaveProperty('error');
  });
  it('renames a branch and the rules that name it', () => {
    const d = sampleDraft();
    const next = ok(renameBranch(d, 'intent', 'sales', 'buy'));
    expect(next.nodes[0]!.branches[0]!.key).toBe('buy');
    const rules = next.nodes[0]!.engines[0]!;
    expect(rules.kind === 'rules' && rules.rules[0]!.branch).toBe('buy');
    expect(renameBranch(d, 'intent', 'sales', 'support')).toHaveProperty('error');
  });
  it('moves and removes steps without mutating or leaving the bounds', () => {
    const list = [1, 2, 3];
    expect(moveStep(list, 0, 1)).toEqual([2, 1, 3]);
    expect(moveStep(list, 0, -1)).toEqual([1, 2, 3]);
    expect(moveStep(list, 2, 1)).toEqual([1, 2, 3]);
    expect(removeStep(list, 1)).toEqual([1, 3]);
    expect(removeStep([1], 0, 1)).toEqual([1]);
    expect(list).toEqual([1, 2, 3]);
  });
});

describe('renameQueueKey', () => {
  it('rewrites every place that names the key', () => {
    const d = sampleDraft();
    d.transfer!.hold!.onTimeout.unshift({ kind: 'human', queueId: 'desk' });
    const next = ok(renameQueueKey(d, 'desk', 'floor'));
    expect(next.humanQueues![0]!.key).toBe('floor');
    expect(next.nodes[0]!.branches[2]!.target).toEqual({ kind: 'human', queueId: 'floor' });
    expect(next.transfer!.hold!.onTimeout[0]).toEqual({ kind: 'human', queueId: 'floor' });
    expect(renameQueueKey(d, 'desk', 'Bad key')).toHaveProperty('error');
    expect(renameQueueKey(d, 'nope', 'x')).toHaveProperty('error');
  });
});
