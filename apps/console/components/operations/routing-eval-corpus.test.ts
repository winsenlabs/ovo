import { describe, expect, it } from 'vitest';
import { CORPUS_LIMITS, parseRoutingCorpus } from './routing-eval-corpus';

const good = (overrides: Record<string, unknown> = {}) => ({
  id: 'sales-hi',
  description: 'Hindi sales',
  tags: ['sales'],
  call: { from: '+919800004321', variables: { plan: 'gold' }, at: '2026-10-20T09:30:00+05:30' },
  turns: [
    { kind: 'speech', text: 'mujhe naya credit card chahiye' },
    { kind: 'dtmf', digits: '1#' },
    { kind: 'silence' },
  ],
  answers: [{ node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.91, repeat: true }],
  faults: { queues: { desk: 'queue_closed' } },
  expect: {
    status: 'agent',
    path: ['language', 'intent'],
    branches: { intent: 'sales' },
    fallback: 'none',
    clarify: false,
  },
  ...overrides,
});
const message = (source: string) => {
  const result = parseRoutingCorpus(source);
  return result.ok ? 'ok' : result.message;
};
const one = (overrides: Record<string, unknown>) => message(JSON.stringify([good(overrides)]));

describe('routing corpus parsing', () => {
  it('accepts a JSON array and the same cases as JSONL', () => {
    const cases = [good(), good({ id: 'support-en' })];
    expect(parseRoutingCorpus(JSON.stringify(cases))).toEqual({ ok: true, cases });
    expect(parseRoutingCorpus(cases.map((c) => JSON.stringify(c)).join('\n\n'))).toEqual({
      ok: true,
      cases,
    });
  });

  it.each([
    ['', 'Paste or upload a corpus first.'],
    ['   ', 'Paste or upload a corpus first.'],
    ['[]', 'The corpus has no cases.'],
    ['[{"id":', 'The corpus is not valid JSON.'],
    ['{"id":"a"}\n{nope}', 'Line 2 is not valid JSON.'],
  ])('refuses %j with %s', (source, expected) => {
    expect(message(source)).toBe(expected);
  });

  it('refuses a corpus over the case count or byte limit', () => {
    const many = Array.from({ length: CORPUS_LIMITS.cases + 1 }, (_, i) => good({ id: `c${i}` }));
    expect(message(JSON.stringify(many))).toMatch(/has 501 cases; the limit is 500/);
    expect(message(`[${' '.repeat(CORPUS_LIMITS.bytes)}]`)).toMatch(/over 1 MiB/);
  });

  it.each([
    ['an uppercase id', { id: 'Sales' }, /Case 1 \(Sales\): id must be an id/],
    ['a missing expect', { expect: undefined }, /Case 1 \(sales-hi\): expect is required/],
    ['an empty expect', { expect: {} }, /expect must assert at least one thing/],
    [
      'an unknown expect field',
      { expect: { colour: 'red' } },
      /expect.colour is not a known field/,
    ],
    ['a bad status', { expect: { status: 'maybe' } }, /expect.status must be one of agent, queue/],
    [
      'a bad fallback step',
      { expect: { fallback: 'panic' } },
      /expect.fallback must be one of none/,
    ],
    ['a bad caller number', { call: { from: '9800004321' } }, /call.from must be an E.164 number/],
    ['a bad clock', { call: { at: 'tomorrow' } }, /call.at must be an ISO date-time/],
    ['an unknown top-level field', { extra: 1 }, /extra is not a known field/],
    [
      'bad dtmf',
      { turns: [{ kind: 'dtmf', digits: '12345678901' }] },
      /turns\[0\]\.digits must be 1 to 8/,
    ],
    [
      'empty speech',
      { turns: [{ kind: 'speech', text: ' ' }] },
      /turns\[0\]\.text must be text of 1 to 500/,
    ],
    [
      'an unknown turn kind',
      { turns: [{ kind: 'shout' }] },
      /turns\[0\]\.kind must be one of speech, dtmf, silence/,
    ],
    [
      'too many turns',
      { turns: Array.from({ length: 21 }, () => ({ kind: 'silence' })) },
      /turns must have at most 20/,
    ],
    [
      'a speech turn with digits',
      { turns: [{ kind: 'speech', text: 'hi', digits: '1' }] },
      /turns\[0\]\.digits is not a known field/,
    ],
    [
      'confidence above 1',
      { answers: [{ node: 'n', engine: 'llm', confidence: 1.2 }] },
      /answers\[0\]\.confidence must be a number from 0 to 1/,
    ],
    [
      'an engine that is not scriptable',
      { answers: [{ node: 'n', engine: 'rules' }] },
      /answers\[0\]\.engine must be one of decision, llm, external/,
    ],
    ['a null branch is allowed', { answers: [{ node: 'n', engine: 'llm', branch: null }] }, /^ok$/],
    [
      'a queue fault code',
      { faults: { queues: { desk: 'on_fire' } } },
      /faults.queues.desk must be one of queue_closed/,
    ],
    ['a tag that is not a key', { tags: ['Bad Tag'] }, /tags\[0\] must be a key/],
    [
      'too many tags',
      { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      /tags must have at most 10/,
    ],
  ])('%s', (_name, overrides, expected) => {
    expect(one(overrides)).toMatch(expected);
  });

  it('names the first failing case, counting from one', () => {
    const cases = [
      good(),
      good({ id: 'second' }),
      good({ id: 'third', expect: { status: 'nope' } }),
    ];
    expect(message(JSON.stringify(cases))).toMatch(/^Case 3 \(third\): expect.status/);
  });

  it('refuses a repeated id', () => {
    expect(message(JSON.stringify([good(), good()]))).toBe(
      'Case 2 (sales-hi): id is used by an earlier case.',
    );
  });

  it('refuses a case that is not an object', () => {
    expect(message('[1]')).toBe('Case 1: must be an object');
  });
});
