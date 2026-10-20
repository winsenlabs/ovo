import { describe, expect, it } from 'vitest';
import {
  RoutingPointDraft,
  addNode,
  blankRoutingNode,
  deleteNode,
  moveStep,
  removeStep,
  renameBranch,
  renameNode,
  routingDraftIssues,
  routingNodeReferrers,
  type RoutingEditResult,
} from '../src/index.ts';
import { draft, draftInput } from './routing-fixture.ts';
import { transferInput } from './transfer-fixture.ts';

const end = { kind: 'end', line: { en: 'Goodbye.' } };
const second = {
  id: 'billing',
  ask: { en: 'Billing?' },
  engines: [{ kind: 'rules', rules: [{ branch: 'go', when: [{ kind: 'dtmf', digits: '1' }] }] }],
  branches: [{ key: 'go', description: 'Go on', target: end }],
  fallback: [end],
};
/** Two nodes: `intent` leads to `billing`, and a transfer re-routes to `billing`. */
function linked() {
  return draft((d) => {
    d.nodes[0].branches[1] = { key: 'support', description: 'Support', next: 'billing' };
    d.nodes.push(second);
    d.transfer = transferInput();
    d.transfer.targets[1].destination.node = 'billing';
  });
}
const ok = (result: RoutingEditResult): RoutingPointDraft => {
  if ('error' in result) throw new Error(result.error.message);
  return result.draft;
};
const err = (result: RoutingEditResult) => {
  if (!('error' in result)) throw new Error('expected a refusal');
  return result.error;
};

describe('renameNode', () => {
  it('rewrites root, branch next and transfer node destinations', () => {
    const renamed = ok(renameNode(linked(), 'billing', 'payments'));
    expect(renamed.nodes[1]!.id).toBe('payments');
    expect(renamed.nodes[0]!.branches[1]!.next).toBe('payments');
    expect(renamed.transfer!.targets[1]!.destination).toEqual({ kind: 'node', node: 'payments' });
    expect(routingDraftIssues(renamed)).toEqual(routingDraftIssues(linked()));
    const root = ok(renameNode(linked(), 'intent', 'start'));
    expect(root.root).toBe('start');
    expect(root.nodes[0]!.id).toBe('start');
  });

  it('does not change its input', () => {
    const input = linked();
    const before = structuredClone(input);
    ok(renameNode(input, 'billing', 'payments'));
    expect(input).toEqual(before);
  });

  it('refuses an invalid id, an unknown node and a duplicate', () => {
    expect(err(renameNode(linked(), 'billing', 'Payments')).code).toBe('invalid_id');
    expect(err(renameNode(linked(), 'billing', '')).code).toBe('invalid_id');
    expect(err(renameNode(linked(), 'ghost', 'ghost2')).code).toBe('node_unknown');
    expect(err(renameNode(linked(), 'billing', 'intent')).code).toBe('node_exists');
  });

  it('renaming to the same id is a no-op', () => {
    expect(ok(renameNode(linked(), 'billing', 'billing'))).toEqual(linked());
  });
});

describe('renameBranch', () => {
  it('rewrites the rules that choose the branch', () => {
    const renamed = ok(renameBranch(draft(), 'intent', 'sales', 'buy'));
    const rules = renamed.nodes[0]!.engines[0]!;
    expect(rules.kind === 'rules' && rules.rules.map((r) => r.branch)).toEqual(['buy', 'support']);
    expect(renamed.nodes[0]!.branches.map((b) => b.key)).toEqual(['buy', 'support']);
    expect(routingDraftIssues(renamed)).toEqual([]);
  });

  it('refuses unknown nodes and branches, duplicates and invalid keys', () => {
    expect(err(renameBranch(draft(), 'ghost', 'a', 'b')).code).toBe('node_unknown');
    expect(err(renameBranch(draft(), 'intent', 'ghost', 'b')).code).toBe('branch_unknown');
    expect(err(renameBranch(draft(), 'intent', 'sales', 'support')).code).toBe('branch_exists');
    expect(err(renameBranch(draft(), 'intent', 'sales', 'Bad Key')).code).toBe('invalid_id');
  });
});

describe('deleteNode', () => {
  it('refuses the root', () => {
    const error = err(deleteNode(linked(), 'intent'));
    expect(error).toMatchObject({ code: 'root_delete' });
  });

  it('refuses a node something still points at, and says where', () => {
    const error = err(deleteNode(linked(), 'billing'));
    expect(error.code).toBe('node_referenced');
    expect(error.referrers).toEqual([
      ['nodes', 0, 'branches', 1, 'next'],
      ['transfer', 'targets', 1, 'destination', 'node'],
    ]);
    expect(routingNodeReferrers(linked(), 'billing')).toEqual(error.referrers);
  });

  it('deletes an unreferenced node and refuses unknown ones', () => {
    const lone = draft((d) => d.nodes.push(second));
    expect(ok(deleteNode(lone, 'billing')).nodes.map((n) => n.id)).toEqual(['intent']);
    expect(err(deleteNode(lone, 'ghost')).code).toBe('node_unknown');
  });
});

describe('addNode and blankRoutingNode', () => {
  it('refuses a node past the limit of a point', () => {
    let full = linked();
    while (full.nodes.length < 100)
      full = ok(addNode(full, blankRoutingNode(full, `n${full.nodes.length}`)));
    expect(err(addNode(full, blankRoutingNode(full, 'extra'))).code).toBe('node_limit');
  });

  it('appends or inserts a node', () => {
    const base = linked();
    expect(ok(addNode(base, blankRoutingNode(base, 'extra'))).nodes.map((n) => n.id)).toEqual([
      'intent',
      'billing',
      'extra',
    ]);
    expect(
      ok(addNode(base, blankRoutingNode(base, 'extra'), { after: 'intent' })).nodes.map(
        (n) => n.id,
      ),
    ).toEqual(['intent', 'extra', 'billing']);
  });

  it('a blank node is valid by construction and reachable once linked', () => {
    const base = draft();
    const node = blankRoutingNode(base, 'extra');
    expect(node.engines[0]!.kind).toBe('llm');
    const next = ok(addNode(base, node));
    expect(routingDraftIssues(next).map((i) => i.code)).toEqual(['routing_node_unreachable']);
    const linkedUp = ok(renameNode(next, 'extra', 'extra2'));
    expect(routingDraftIssues(linkedUp).map((i) => i.code)).toEqual(['routing_node_unreachable']);
  });

  it('a blank node uses the draft default language', () => {
    const hindi = draft((d) => {
      d.language = { default: 'hi', allowed: ['hi'] };
      d.greeting = { hi: 'नमस्ते' };
    });
    expect(blankRoutingNode(hindi, 'x').ask).toEqual({ hi: 'How can I help you today?' });
  });

  it('refuses duplicates, invalid ids and an unknown insertion point', () => {
    const base = draft();
    expect(err(addNode(base, blankRoutingNode(base, 'intent'))).code).toBe('node_exists');
    expect(err(addNode(base, { ...blankRoutingNode(base, 'x'), id: 'No' })).code).toBe(
      'invalid_id',
    );
    expect(err(addNode(base, blankRoutingNode(base, 'x'), { after: 'ghost' })).code).toBe(
      'node_unknown',
    );
  });
});

describe('moveStep and removeStep', () => {
  it('reorders engines, fallback steps and branches', () => {
    const moved = ok(moveStep(draft(), 'intent', 'engines', 0, 1));
    expect(moved.nodes[0]!.engines.map((e) => e.kind)).toEqual(['llm', 'rules']);
    const fallback = ok(moveStep(draft(), 'intent', 'fallback', 2, 0));
    expect(fallback.nodes[0]!.fallback.map((s) => s.kind)).toEqual(['end', 'reask', 'default']);
    const branches = ok(moveStep(draft(), 'intent', 'branches', 1, 0));
    expect(branches.nodes[0]!.branches.map((b) => b.key)).toEqual(['support', 'sales']);
  });

  it('refuses unknown nodes and out-of-range positions', () => {
    expect(err(moveStep(draft(), 'ghost', 'engines', 0, 1)).code).toBe('node_unknown');
    expect(err(moveStep(draft(), 'intent', 'engines', 5, 0)).code).toBe('step_unknown');
    expect(err(moveStep(draft(), 'intent', 'engines', 0, 2)).code).toBe('step_unknown');
    expect(err(moveStep(draft(), 'intent', 'engines', 0, -1)).code).toBe('step_unknown');
  });

  it('removes a step but never the last one', () => {
    const removed = ok(removeStep(draft(), 'intent', 'engines', 1));
    expect(removed.nodes[0]!.engines.map((e) => e.kind)).toEqual(['rules']);
    expect(err(removeStep(removed, 'intent', 'engines', 0)).code).toBe('last_step');
    expect(err(removeStep(draft(), 'intent', 'fallback', 9)).code).toBe('step_unknown');
    expect(err(removeStep(draft(), 'ghost', 'fallback', 0)).code).toBe('node_unknown');
  });

  it('keeps edited drafts parseable', () => {
    const moved = ok(moveStep(draft(), 'intent', 'fallback', 0, 2));
    expect(RoutingPointDraft.safeParse(moved).success).toBe(true);
    expect(RoutingPointDraft.safeParse(draftInput()).success).toBe(true);
  });
});
