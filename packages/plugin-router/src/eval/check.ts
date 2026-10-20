import type { RoutingEvalExpect } from './types.ts';
import type { CaseActual } from './actual.ts';

export const FIELDS = [
  'status',
  'path',
  'node',
  'branch',
  'pool',
  'member',
  'agent',
  'queue',
  'language',
] as const;
export type Field = (typeof FIELDS)[number];

export interface CaseCheck {
  /** For each field the case asserts, whether it held. `fallback` and `clarify` count only toward passing. */
  fields: Partial<Record<Field | 'fallback' | 'clarify', boolean>>;
  passed: boolean;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  /** One line per field that differs: never an utterance. */
  diff: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compares what a case expects with what the simulated call did. A case passes when every asserted field holds. */
export function checkCase(expect: RoutingEvalExpect, actual: CaseActual): CaseCheck {
  const fields: CaseCheck['fields'] = {};
  const expected: Record<string, unknown> = {};
  const got: Record<string, unknown> = {};
  const diff: string[] = [];
  const assert = (
    field: keyof CaseCheck['fields'],
    want: unknown,
    have: unknown,
    ok = same(want, have),
  ) => {
    fields[field] = ok;
    expected[field] = want;
    got[field] = have;
    if (!ok)
      diff.push(`${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(have ?? null)}`);
  };
  if (expect.status) assert('status', expect.status, actual.status);
  if (expect.path) assert('path', expect.path, actual.path);
  if (expect.node) assert('node', expect.node, actual.node);
  if (expect.branches) {
    const have = Object.fromEntries(
      Object.keys(expect.branches).map((node) => [node, actual.branches[node] ?? 'none']),
    );
    assert('branch', expect.branches, have);
  }
  if (expect.pool)
    assert(
      'pool',
      expect.pool,
      actual.pool?.name,
      expect.pool === actual.pool?.name || expect.pool === actual.pool?.id,
    );
  if (expect.member) assert('member', expect.member, actual.member);
  if (expect.agentId) assert('agent', expect.agentId, actual.agentId);
  if (expect.queue) assert('queue', expect.queue, actual.queue);
  if (expect.language) assert('language', expect.language, actual.language);
  if (expect.fallback) assert('fallback', expect.fallback, actual.fallback);
  if (expect.clarify !== undefined) assert('clarify', expect.clarify, actual.clarify);
  return { fields, passed: Object.values(fields).every(Boolean), expected, actual: got, diff };
}
