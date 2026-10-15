import { describe, expect, it } from 'vitest';
import {
  ROUTING_ISSUE_CODES,
  ROUTING_STRUCTURAL_ISSUE_CODES,
  routingDraftIssues,
  type RoutingIssueCode,
} from '../src/index.ts';
import { POOL_SALES, draft } from './routing-fixture.ts';

const line = { en: 'Goodbye.' };
const end = { kind: 'end', line };
/** A node with one branch to `next` (or an end target), deciding by keypad. */
function chain(id: string, next?: string) {
  return {
    id,
    ask: { en: `Question ${id}?` },
    engines: [{ kind: 'rules', rules: [{ branch: 'go', when: [{ kind: 'dtmf', digits: '1' }] }] }],
    branches: [{ key: 'go', description: 'Go on', ...(next ? { next } : { target: end }) }],
    fallback: [end],
  };
}
const codes = (found: { code: RoutingIssueCode }[]) => found.map((issue) => issue.code);

describe('routingDraftIssues', () => {
  it('finds nothing wrong with the worked example', () => {
    expect(routingDraftIssues(draft())).toEqual([]);
  });

  it('covers every structural code with a test below', () => {
    // The 7 R2 transfer codes are covered in routing-transfer-issues.test.ts, the 6 R3 queue codes
    // in human-queue-issues.test.ts.
    expect(ROUTING_STRUCTURAL_ISSUE_CODES).toHaveLength(27);
    expect(new Set(ROUTING_ISSUE_CODES).size).toBe(ROUTING_ISSUE_CODES.length);
  });

  it('routing_root_missing: the root names no node', () => {
    const found = routingDraftIssues(draft((d) => (d.root = 'nowhere')));
    expect(found).toEqual([
      expect.objectContaining({ code: 'routing_root_missing', path: ['root'], severity: 'error' }),
    ]);
  });

  it('routing_node_duplicate: two nodes share an id', () => {
    const found = routingDraftIssues(draft((d) => d.nodes.push(chain('intent'))));
    expect(found).toContainEqual(
      expect.objectContaining({ code: 'routing_node_duplicate', path: ['nodes', 1, 'id'] }),
    );
  });

  it('routing_node_unknown: a branch goes to a node that does not exist', () => {
    const found = routingDraftIssues(draft((d) => (d.nodes = [chain('intent', 'ghost')])));
    expect(found).toContainEqual(
      expect.objectContaining({
        code: 'routing_node_unknown',
        path: ['nodes', 0, 'branches', 0, 'next'],
      }),
    );
  });

  it('routing_node_cycle: branches loop back to an open node', () => {
    const found = routingDraftIssues(
      draft((d) => (d.nodes = [chain('intent', 'b'), chain('b', 'intent')])),
    );
    expect(codes(found)).toEqual(['routing_node_cycle']);
    expect(found[0]!.path).toEqual(['nodes', 1, 'branches', 0, 'next']);
    expect(
      codes(routingDraftIssues(draft((d) => (d.nodes = [chain('intent', 'intent')])))),
    ).toEqual(['routing_node_cycle']);
  });

  it('routing_node_unreachable: a warning for a node nothing leads to', () => {
    const found = routingDraftIssues(draft((d) => d.nodes.push(chain('orphan'))));
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_node_unreachable',
        severity: 'warning',
        path: ['nodes', 1],
      }),
    ]);
  });

  it('routing_depth_exceeded: more than eight levels from the root', () => {
    const ids = ['intent', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'];
    const nine = draft((d) => (d.nodes = ids.map((id, i) => chain(id, ids[i + 1]))));
    expect(codes(routingDraftIssues(nine))).toEqual(['routing_depth_exceeded']);
    const eight = draft(
      (d) =>
        (d.nodes = ids
          .slice(0, 8)
          .map((id, i) => chain(id, ids[i + 1] === 'n9' ? undefined : ids[i + 1]))),
    );
    expect(routingDraftIssues(eight)).toEqual([]);
    // The longest path counts, not the first one found.
    const diamond = draft((d) => {
      d.nodes = ids.map((id, i) => chain(id, ids[i + 1]));
      d.nodes[0].branches.unshift({ key: 'skip', description: 'Skip ahead', next: 'n9' });
    });
    expect(codes(routingDraftIssues(diamond))).toEqual(['routing_depth_exceeded']);
  });

  it('routing_branch_duplicate: a branch key is used twice in a node', () => {
    const found = routingDraftIssues(
      draft((d) => d.nodes[0].branches.push({ ...d.nodes[0].branches[0] })),
    );
    expect(codes(found)).toEqual(['routing_branch_duplicate']);
  });

  it('routing_rule_branch_unknown: a rule names a branch the node lacks', () => {
    const found = routingDraftIssues(
      draft((d) => (d.nodes[0].engines[0].rules[0].branch = 'billing')),
    );
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_rule_branch_unknown',
        path: ['nodes', 0, 'engines', 0, 'rules', 0, 'branch'],
      }),
    ]);
  });

  it('routing_fallback_not_terminal: the chain must end in default, callback or end', () => {
    const found = routingDraftIssues(draft((d) => (d.nodes[0].fallback = [{ kind: 'reask' }])));
    expect(codes(found)).toEqual(['routing_fallback_not_terminal']);
    const callback = draft((d) => (d.nodes[0].fallback = [{ kind: 'callback', line }]));
    expect(routingDraftIssues(callback)).toEqual([]);
  });

  it('routing_line_default_missing: a line has no default-language text', () => {
    const found = routingDraftIssues(draft((d) => (d.nodes[0].ask = { hi: 'क्या?' })));
    expect(found).toEqual([
      expect.objectContaining({ code: 'routing_line_default_missing', path: ['nodes', 0, 'ask'] }),
    ]);
  });

  it('routing_language_unallowed: lines, language branches and the default must be allowed', () => {
    const line = routingDraftIssues(draft((d) => (d.greeting.ta = 'வணக்கம்')));
    expect(line).toEqual([
      expect.objectContaining({ code: 'routing_language_unallowed', path: ['greeting', 'ta'] }),
    ]);
    const sets = routingDraftIssues(
      draft((d) => {
        d.nodes[0].sets = 'language';
        d.nodes[0].branches[0].key = 'hi';
        d.nodes[0].branches[1].key = 'ta';
        d.nodes[0].engines = [{ kind: 'llm', instructions: 'Which language?' }];
      }),
    );
    expect(sets).toEqual([
      expect.objectContaining({
        code: 'routing_language_unallowed',
        path: ['nodes', 0, 'branches', 1, 'key'],
      }),
    ]);
    const fallbackDefault = routingDraftIssues(draft((d) => (d.language.allowed = ['hi'])));
    expect(fallbackDefault).toContainEqual(
      expect.objectContaining({
        code: 'routing_language_unallowed',
        path: ['language', 'allowed'],
      }),
    );
  });

  it('routing_node_ask_missing: a node waiting for the caller has nothing to ask', () => {
    const found = routingDraftIssues(draft((d) => delete d.nodes[0].ask));
    expect(codes(found)).toEqual(['routing_node_ask_missing']);
    // A re-ask line is enough, and a node deciding without a caller turn needs neither.
    expect(
      routingDraftIssues(
        draft((d) => {
          delete d.nodes[0].ask;
          d.nodes[0].fallback[0].line = { en: 'Sorry, buying or an existing account?' };
        }),
      ),
    ).toEqual([]);
    expect(
      routingDraftIssues(
        draft((d) => {
          delete d.nodes[0].ask;
          d.nodes[0].engines = [
            {
              kind: 'rules',
              rules: [{ branch: 'sales', when: [{ kind: 'caller-id', prefixes: ['+91'] }] }],
            },
          ];
        }),
      ),
    ).toEqual([]);
  });

  it('routing_human_unavailable: human queues are a warning in R1', () => {
    const found = routingDraftIssues(
      draft((d) => d.nodes[0].fallback.splice(1, 0, { kind: 'human', queueId: 'desk' })),
    );
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_human_unavailable',
        severity: 'warning',
        path: ['nodes', 0, 'fallback', 1],
      }),
    ]);
  });

  it('routing_limits_exceeded: more than 50 pools in one tree', () => {
    const pool = (i: number) => POOL_SALES.replace(/^1{8}/, String(i).padStart(8, '0'));
    const branches = (from: number) =>
      Array.from({ length: 26 }, (_, i) => ({
        key: `p${from + i}`,
        description: 'x',
        target: { kind: 'pool', poolId: pool(from + i) },
      }));
    const found = routingDraftIssues(
      draft((d) => {
        d.nodes = [
          {
            ...chain('intent', 'more'),
            branches: [...branches(0), { key: 'go', description: 'More', next: 'more' }],
          },
          {
            ...chain('more'),
            branches: [...branches(26), { key: 'go', description: 'x', target: end }],
          },
        ];
      }),
    );
    expect(codes(found)).toEqual(['routing_limits_exceeded']);
  });
});
