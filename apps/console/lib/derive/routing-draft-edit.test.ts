import { deleteNode, renameNode } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { moveItem, removeItem } from './list-edit';
import {
  editErrorMessage,
  isRoutingKey,
  referrersOf,
  renameQueueKey,
  replaceNode,
} from './routing-draft-edit';
import { sampleDraft } from './routing-support.test-helpers';

const ok = <T extends { draft?: unknown; error?: unknown }>(result: T) => {
  expect(result.error).toBeUndefined();
  return result.draft as ReturnType<typeof sampleDraft>;
};
const refusal = (draft: ReturnType<typeof sampleDraft>, result: ReturnType<typeof deleteNode>) => {
  if (!('error' in result)) throw new Error('expected a refusal');
  return editErrorMessage(draft, result.error);
};

describe('contract edits as the designer words them', () => {
  it('names who still uses a node and refuses the root', () => {
    const d = sampleDraft();
    expect(refusal(d, deleteNode(d, 'intent'))).toContain('first question');
    expect(refusal(d, deleteNode(d, 'support_kind'))).toContain('intent > support');
    d.transfer!.targets.push({
      key: 'back',
      description: 'x',
      destination: { kind: 'node', node: 'support_kind' },
    });
    expect(refusal(d, deleteNode(d, 'support_kind'))).toContain('transfer target back');
  });
  it('turns invalid and taken ids into one sentence each', () => {
    const d = sampleDraft();
    expect(refusal(d, renameNode(d, 'intent', 'Not Valid'))).toContain('lowercase letters');
    expect(refusal(d, renameNode(d, 'intent', 'support_kind'))).toBe(
      'Node support_kind already exists.',
    );
    expect(refusal(d, renameNode(d, 'nope', 'x'))).toBe('No node nope.');
  });
  it('lists who leads to a node, for the "reached from" line', () => {
    const d = sampleDraft();
    expect(referrersOf(d, 'support_kind')).toEqual(['intent > support']);
    expect(referrersOf(d, 'intent')).toEqual(['the first question']);
  });
  it('replaces a node in place', () => {
    const d = sampleDraft();
    const next = replaceNode(d, 'intent', { ...d.nodes[0]!, reuseTurn: false });
    expect(next.nodes.map((n) => n.id)).toEqual(['intent', 'support_kind']);
    expect(next.nodes[0]!.reuseTurn).toBe(false);
  });
  it('checks keys against the contract grammar', () => {
    expect(isRoutingKey('desk-2')).toBe(true);
    expect(isRoutingKey('Desk')).toBe(false);
    expect(isRoutingKey('')).toBe(false);
  });
});

describe('list edits', () => {
  it('moves and removes items without mutating or leaving the bounds', () => {
    const list = [1, 2, 3];
    expect(moveItem(list, 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem(list, 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem(list, 2, 1)).toEqual([1, 2, 3]);
    expect(removeItem(list, 1)).toEqual([1, 3]);
    expect(removeItem([1], 0, 1)).toEqual([1]);
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
