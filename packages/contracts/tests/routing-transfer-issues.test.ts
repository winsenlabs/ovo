import { describe, expect, it } from 'vitest';
import {
  RoutingPointDraft,
  routingDraftIssues,
  transferLines,
  type RoutingIssueCode,
} from '../src/index.ts';
import { draftInput } from './routing-fixture.ts';
import { transferInput } from './transfer-fixture.ts';

/** The worked draft with `transferInput()`, patched. */
function issues(patch: (transfer: Record<string, any>) => void) {
  const transfer = transferInput();
  patch(transfer);
  return routingDraftIssues(RoutingPointDraft.parse({ ...draftInput(), transfer }));
}
const only = (found: { code: RoutingIssueCode }[]) => found.map((issue) => issue.code);
const hold = (onTimeout: unknown[], steps: unknown[] = [{ kind: 'silence', seconds: 2 }]) => ({
  steps,
  onTimeout,
});

describe('transfer structural issues', () => {
  it('finds nothing wrong with the worked example', () => {
    expect(issues(() => {})).toEqual([]);
  });

  it('routing_transfer_key_duplicate: two targets share a key', () => {
    const found = issues((t) => t.targets.push({ ...t.targets[0] }));
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_key_duplicate',
        path: ['transfer', 'targets', 4, 'key'],
        severity: 'error',
      }),
    ]);
  });

  it('routing_transfer_node_unknown: a re-route names no node', () => {
    const found = issues((t) => (t.targets[1].destination.node = 'ghost'));
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_node_unknown',
        path: ['transfer', 'targets', 1, 'destination', 'node'],
      }),
    ]);
  });

  it('routing_transfer_timeout_not_terminal: a chain must end in default, callback or end', () => {
    const found = issues(
      (t) => (t.targets[0].hold.onTimeout = [{ kind: 'default' }, { kind: 'return' }]),
    );
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_timeout_not_terminal',
        path: ['transfer', 'targets', 0, 'hold', 'onTimeout'],
      }),
    ]);
    expect(only(issues((t) => (t.hold.onTimeout = [{ kind: 'target', key: 'senior' }])))).toEqual([
      'routing_transfer_timeout_not_terminal',
    ]);
  });

  it('routing_transfer_timeout_target_unknown: an unknown key or the hold own target', () => {
    const unknown = issues(
      (t) => (t.hold.onTimeout = [{ kind: 'target', key: 'nobody' }, { kind: 'default' }]),
    );
    expect(unknown).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_timeout_target_unknown',
        path: ['transfer', 'hold', 'onTimeout', 0, 'key'],
      }),
    ]);
    const own = issues(
      (t) =>
        (t.targets[0].hold.onTimeout = [
          { kind: 'target', key: 'support' },
          { kind: 'end', line: { en: 'Bye' } },
        ]),
    );
    expect(own).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_timeout_target_unknown',
        message: 'A hold cannot time out into its own target',
      }),
    ]);
    expect(
      issues(
        (t) =>
          (t.targets[0].hold.onTimeout = [{ kind: 'target', key: 'senior' }, { kind: 'default' }]),
      ),
    ).toEqual([]);
  });

  it('routing_transfer_hold_loop_invalid: loopFrom names no step', () => {
    const found = issues((t) => (t.hold.loopFrom = 2));
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_hold_loop_invalid',
        path: ['transfer', 'hold', 'loopFrom'],
      }),
    ]);
    expect(issues((t) => (t.hold.loopFrom = 1))).toEqual([]);
  });

  it('routing_transfer_return_unused: a warning for return in the point-level hold', () => {
    const found = issues((t) => (t.hold = hold([{ kind: 'return' }, { kind: 'default' }])));
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_return_unused',
        severity: 'warning',
        path: ['transfer', 'hold', 'onTimeout', 0],
      }),
    ]);
  });

  it('routing_transfer_human_unavailable: a warning for a human step', () => {
    const found = issues(
      (t) => (t.targets[0].hold = hold([{ kind: 'human', queueId: 'desk' }, { kind: 'default' }])),
    );
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_human_unavailable',
        severity: 'warning',
        path: ['transfer', 'targets', 0, 'hold', 'onTimeout', 0],
      }),
    ]);
  });

  it('walks every transfer line for the default language and the allowed languages', () => {
    const found = issues((t) => {
      t.queueAnnouncement = { hi: 'कृपया होल्ड करें।' };
      t.targets[0].announcement = { en: 'Moving you.', fr: 'Un instant.' };
      t.hold.onTimeout[1].line = { hi: 'धन्यवाद।' };
    });
    expect(found.map((issue) => [issue.code, issue.path])).toEqual([
      ['routing_line_default_missing', ['transfer', 'queueAnnouncement']],
      ['routing_language_unallowed', ['transfer', 'targets', 0, 'announcement', 'fr']],
      ['routing_line_default_missing', ['transfer', 'hold', 'onTimeout', 1, 'line']],
    ]);
  });

  it('lists the transfer lines with their paths', () => {
    const parsed = RoutingPointDraft.parse({ ...draftInput(), transfer: transferInput() });
    expect(transferLines(parsed.transfer).map((line) => line.path)).toEqual([
      ['transfer', 'announcement'],
      ['transfer', 'targets', 0, 'label'],
      ['transfer', 'hold', 'steps', 1, 'line'],
      ['transfer', 'hold', 'onTimeout', 1, 'line'],
    ]);
    expect(transferLines(undefined)).toEqual([]);
  });

  it('counts transfer pools toward the per-release pool limit', () => {
    const uuid = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const input = draftInput() as Record<string, any>;
    input.nodes[0].engines = [{ kind: 'llm', instructions: 'Pick one.' }];
    input.nodes[0].branches = Array.from({ length: 20 }, (_, i) => ({
      key: `b${i}`,
      description: 'A pool',
      target: { kind: 'pool', poolId: uuid(i) },
    }));
    const targets = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        key: `p${i}`,
        description: 'A pool',
        destination: { kind: 'pool', poolId: uuid(100 + i) },
      }));
    const codes = (count: number) =>
      only(
        routingDraftIssues(
          RoutingPointDraft.parse({ ...input, transfer: { targets: targets(count) } }),
        ),
      );
    expect(codes(30)).toEqual([]);
    expect(codes(31)).toEqual(['routing_limits_exceeded']);
  });
});
