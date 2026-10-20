import { describe, expect, it } from 'vitest';
import { SIMULATION_LIMITS, SimulationRequest, RoutingEvalCase } from '../src/wire/index.ts';

const target = { kind: 'release', routingReleaseId: '00000000-0000-4000-8000-0000000000a2' };
const caseOf = (over: Record<string, unknown> = {}) => ({
  id: 'sales.hi',
  expect: { status: 'agent' },
  ...over,
});

describe('SimulationRequest', () => {
  it('fills every default from a bare target', () => {
    expect(SimulationRequest.parse({ target })).toEqual({
      target,
      call: { variables: {} },
      turns: [],
      engines: { mode: { decision: 'mock', llm: 'mock', external: 'mock' }, answers: [] },
      faults: { fullMembers: [], failedReleases: [], queues: {} },
      load: 'empty',
      assume: {},
    });
  });

  it.each([
    [
      'speech, keypad and silence turns',
      {
        turns: [
          { kind: 'speech', text: 'hi' },
          { kind: 'dtmf', digits: '12*#' },
          { kind: 'silence' },
        ],
      },
    ],
    [
      'an unpublished draft',
      { target: { kind: 'draft', pointId: '00000000-0000-4000-8000-0000000000a1' } },
    ],
    [
      'a caller, a clock and variables',
      {
        call: {
          from: '+912212345678',
          to: '+918000000000',
          at: '2026-10-15T06:30:00Z',
          variables: { vip: 'yes' },
        },
      },
    ],
    [
      'an answer that repeats',
      {
        engines: {
          answers: [
            { node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.9, repeat: true },
          ],
        },
      },
    ],
    [
      'faults',
      {
        faults: {
          fullMembers: [{ poolId: target.routingReleaseId, memberId: 'a' }],
          failedReleases: [{ releaseId: target.routingReleaseId }],
          queues: { desk: 'no_operators' },
        },
      },
    ],
  ])('accepts %s', (_name, over) => {
    expect(SimulationRequest.safeParse({ target, ...over }).success).toBe(true);
  });

  it.each([
    ['no target', { target: undefined }],
    ['an empty utterance', { turns: [{ kind: 'speech', text: '  ' }] }],
    ['an utterance that is too long', { turns: [{ kind: 'speech', text: 'x'.repeat(501) }] }],
    ['keypad letters', { turns: [{ kind: 'dtmf', digits: 'abc' }] }],
    ['too many turns', { turns: Array.from({ length: 21 }, () => ({ kind: 'silence' })) }],
    ['a caller id that is not E.164', { call: { from: '12345' } }],
    ['a clock with no zone', { call: { at: 'yesterday' } }],
    [
      'an unknown engine',
      { engines: { answers: [{ node: 'intent', engine: 'rules', branch: 'sales' }] } },
    ],
    [
      'a confidence above one',
      { engines: { answers: [{ node: 'intent', engine: 'llm', confidence: 1.5 }] } },
    ],
    ['an unknown queue refusal', { faults: { queues: { desk: 'on_fire' } } }],
    ['a stray field', { colour: 'red' }],
  ])('rejects %s', (_name, over) => {
    expect(SimulationRequest.safeParse({ target, ...over }).success).toBe(false);
  });

  it('bounds the sizes the API enforces', () => {
    expect(SIMULATION_LIMITS).toMatchObject({
      turns: 20,
      answers: 100,
      bodyBytes: 65536,
      liveTurns: 8,
      virtualTurnMs: 3000,
    });
  });
});

describe('RoutingEvalCase', () => {
  it('fills defaults and keeps what the case expects', () => {
    expect(RoutingEvalCase.parse(caseOf({ tags: ['sales'] }))).toEqual({
      id: 'sales.hi',
      tags: ['sales'],
      call: { variables: {} },
      turns: [],
      answers: [],
      faults: { fullMembers: [], failedReleases: [], queues: {} },
      expect: { status: 'agent' },
    });
  });

  it.each([
    ['a case that expects nothing', { expect: {} }],
    ['an id with capitals', { id: 'Sales' }],
    ['an unknown status', { expect: { status: 'undecided' } }],
    ['an unknown fallback step', { expect: { fallback: 'panic' } }],
    ['more than ten tags', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    ['an unknown expectation', { expect: { colour: 'red' } }],
  ])('rejects %s', (_name, over) => {
    expect(RoutingEvalCase.safeParse(caseOf(over)).success).toBe(false);
  });
});
