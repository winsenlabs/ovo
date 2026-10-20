import { describe, expect, it } from 'vitest';
import { typedSimulate as simulate } from '../../features/routing/routing-test-support';
import { sampleDraft } from './routing-support.test-helpers';
import {
  answerOf,
  blankSimForm,
  buildEvalCase,
  buildRequest,
  engineSlots,
  evalCaseJsonl,
  formProblem,
  setAnswer,
  unscripted,
  zonedToIso,
} from './routing-simulate';

const target = { kind: 'draft' as const, pointId: 'p' };

describe('zonedToIso', () => {
  it('reads a local time in a zone', () => {
    expect(zonedToIso('2026-10-14T10:30', 'Asia/Kolkata')).toBe('2026-10-14T05:00:00.000Z');
    expect(zonedToIso('2026-10-14T10:30', 'UTC')).toBe('2026-10-14T10:30:00.000Z');
  });
  it('settles across a daylight saving edge and refuses nonsense', () => {
    // 2026-03-08 02:30 does not exist in New York; 03:30 EDT is 07:30Z.
    expect(zonedToIso('2026-03-08T03:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedToIso('2026-11-01T12:00', 'America/New_York')).toBe('2026-11-01T17:00:00.000Z');
    expect(zonedToIso('not a time', 'UTC')).toBeUndefined();
  });
});

describe('buildRequest', () => {
  it('maps the form to the wire request, dropping blanks', () => {
    const form = {
      ...blankSimForm(target),
      from: ' +918040000001 ',
      variables: [
        { name: 'segment', value: 'vip' },
        { name: ' ', value: 'x' },
      ],
      turns: [{ kind: 'dtmf' as const, digits: '1' }],
      at: '2026-10-14T10:30',
      transfers: 'off' as const,
    };
    const request = buildRequest(form, { timeZone: 'Asia/Kolkata' });
    expect(request).toMatchObject({
      target,
      call: {
        from: '+918040000001',
        variables: { segment: 'vip' },
        at: '2026-10-14T05:00:00.000Z',
      },
      turns: [{ kind: 'dtmf', digits: '1' }],
      engines: { mode: { decision: 'mock', llm: 'mock', external: 'mock' }, answers: [] },
      load: 'empty',
      assume: { transferEnabled: false },
    });
    expect(request.call).not.toHaveProperty('to');
    expect(request.assume).not.toHaveProperty('humanQueueEnabled');
  });
  it('sends the working draft only for a draft target', () => {
    const draft = sampleDraft();
    expect(buildRequest(blankSimForm(target), { draft }).target).toMatchObject({ draft });
    expect(
      buildRequest(blankSimForm({ kind: 'release', routingReleaseId: 'r' }), { draft }).target,
    ).toEqual({ kind: 'release', routingReleaseId: 'r' });
  });
  it('explains why a form cannot run', () => {
    expect(formProblem(blankSimForm({ kind: 'release', routingReleaseId: '' }))).toMatch(/release/);
    expect(formProblem({ ...blankSimForm(target), from: '12345' })).toMatch(/international/);
    expect(
      formProblem({ ...blankSimForm(target), turns: [{ kind: 'speech', text: ' ' }] }),
    ).toMatch(/Turn 1/);
    expect(formProblem(blankSimForm(target))).toBeUndefined();
  });
});

describe('engine slots and answers', () => {
  it('lists one slot per model engine, never the rules', () => {
    const slots = engineSlots(sampleDraft());
    expect(slots.map((s) => s.key)).toEqual(['intent:llm', 'support_kind:decision']);
    expect(slots[0]).toMatchObject({
      branches: ['sales', 'support', 'person'],
      detectLanguage: true,
      threshold: 0.6,
    });
  });
  it('replaces an answer for the same node and engine', () => {
    const a = { node: 'intent', engine: 'llm' as const, branch: 'sales', repeat: false };
    const answers = setAnswer(setAnswer([], a, a), a, { ...a, branch: 'support' });
    expect(answers).toHaveLength(1);
    expect(answerOf(answers, a)?.branch).toBe('support');
    expect(setAnswer(answers, a, undefined)).toEqual([]);
  });
});

describe('a result and its eval case', () => {
  const form = { ...blankSimForm(target), turns: [{ kind: 'dtmf' as const, digits: '1' }] };
  const result = simulate(buildRequest(form));
  it('asserts what happened', () => {
    const made = buildEvalCase(form, result, 'case-1');
    expect(made.expect).toMatchObject({
      status: 'agent',
      path: ['intent', 'sales'],
      pool: 'Sales',
      member: 'sales-en',
      fallback: 'none',
      clarify: false,
    });
    expect(made.turns).toEqual(form.turns);
    expect(JSON.parse(evalCaseJsonl([made]).trim()).id).toBe('case-1');
  });
  it('finds the engines that had no scripted answer', () => {
    const run = simulate(
      buildRequest({ ...blankSimForm(target), turns: [{ kind: 'speech', text: 'hello' }] }),
    );
    expect(unscripted(run)).toEqual([{ node: 'intent', engine: 'llm' }]);
    expect(buildEvalCase(blankSimForm(target), run, 'c').expect.clarify).toBe(true);
  });
});
