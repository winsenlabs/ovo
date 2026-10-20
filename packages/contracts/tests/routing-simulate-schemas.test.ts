import { describe, expect, it } from 'vitest';
import {
  SIMULATION_LIMITS,
  SimulatedAnswer,
  SimulationFaults,
  SimulationRequest,
  SimulationTurn,
} from '../src/index.ts';
import { POINT_ID, SALES_EN_RELEASE, draftInput } from './routing-fixture.ts';

const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
const rejects = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);

const release = { kind: 'release', routingReleaseId: SALES_EN_RELEASE };

describe('SimulationTurn', () => {
  it('accepts speech, keypad digits and silence', () => {
    accepts(SimulationTurn, { kind: 'speech', text: 'I want a new card' });
    accepts(SimulationTurn, { kind: 'dtmf', digits: '12*#' });
    accepts(SimulationTurn, { kind: 'silence' });
  });

  it('rejects empty or oversized speech, bad digits and unknown kinds and fields', () => {
    rejects(SimulationTurn, { kind: 'speech', text: '   ' });
    rejects(SimulationTurn, { kind: 'speech', text: 'x'.repeat(501) });
    rejects(SimulationTurn, { kind: 'dtmf', digits: '' });
    rejects(SimulationTurn, { kind: 'dtmf', digits: '123456789' });
    rejects(SimulationTurn, { kind: 'dtmf', digits: '1a' });
    rejects(SimulationTurn, { kind: 'noise' });
    rejects(SimulationTurn, { kind: 'silence', ms: 10 });
  });
});

describe('SimulatedAnswer', () => {
  it('accepts a branch answer, a failure and a repeated answer', () => {
    accepts(SimulatedAnswer, { node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.9 });
    accepts(SimulatedAnswer, { node: 'intent', engine: 'external', outcome: 'timeout' });
    accepts(SimulatedAnswer, {
      node: 'intent',
      engine: 'decision',
      branch: null,
      repeat: true,
      language: 'hi',
      slots: { product: 'card' },
      clarify: 'Which card?',
    });
  });

  it('defaults repeat to false', () => {
    const parsed = SimulatedAnswer.parse({ node: 'intent', engine: 'llm' });
    expect(parsed.repeat).toBe(false);
  });

  it('rejects rules (they run for real), bad ids, confidence out of range and extras', () => {
    rejects(SimulatedAnswer, { node: 'intent', engine: 'rules' });
    rejects(SimulatedAnswer, { node: 'Intent', engine: 'llm' });
    rejects(SimulatedAnswer, { node: 'intent', engine: 'llm', confidence: 1.2 });
    rejects(SimulatedAnswer, { node: 'intent', engine: 'llm', outcome: 'maybe' });
    rejects(SimulatedAnswer, { node: 'intent', engine: 'llm', slots: { Product: 'card' } });
    rejects(SimulatedAnswer, { node: 'intent', engine: 'llm', extra: true });
  });
});

describe('SimulationFaults', () => {
  it('defaults to no faults', () => {
    expect(SimulationFaults.parse(undefined)).toEqual({
      fullMembers: [],
      failedReleases: [],
      queues: {},
    });
  });

  it('accepts each fault kind and defaults the failure reason', () => {
    const parsed = SimulationFaults.parse({
      fullMembers: [{ poolId: POINT_ID, memberId: 'sales-hi' }],
      failedReleases: [{ releaseId: SALES_EN_RELEASE }],
      queues: { desk: 'queue_closed' },
    });
    expect(parsed.failedReleases[0]?.reason).toBe('compose_failed');
  });

  it('rejects an unknown queue fault, a non-uuid id and too many faults', () => {
    rejects(SimulationFaults, { queues: { desk: 'on_fire' } });
    rejects(SimulationFaults, { fullMembers: [{ poolId: 'nope', memberId: 'a' }] });
    rejects(SimulationFaults, {
      fullMembers: Array.from({ length: SIMULATION_LIMITS.faults + 1 }, () => ({
        poolId: POINT_ID,
        memberId: 'a',
      })),
    });
  });
});

describe('SimulationRequest', () => {
  it('accepts the smallest request and fills every default', () => {
    const parsed = SimulationRequest.parse({ target: release });
    expect(parsed).toEqual({
      target: release,
      call: { variables: {} },
      turns: [],
      engines: { mode: { decision: 'mock', llm: 'mock', external: 'mock' }, answers: [] },
      faults: { fullMembers: [], failedReleases: [], queues: {} },
      load: 'empty',
      assume: {},
    });
  });

  it('accepts a full release request', () => {
    accepts(SimulationRequest, {
      target: release,
      call: {
        from: '+919812345678',
        to: '+918040001111',
        variables: { account_id: '42' },
        at: '2026-10-20T10:00:00Z',
      },
      turns: [
        { kind: 'speech', text: 'mujhe naya card chahiye' },
        { kind: 'dtmf', digits: '1' },
      ],
      engines: {
        mode: { llm: 'live' },
        answers: [{ node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.9 }],
      },
      load: 'live',
      assume: { transferEnabled: true, humanQueueEnabled: false },
    });
  });

  it('accepts a draft target, stored or carried', () => {
    accepts(SimulationRequest, { target: { kind: 'draft', pointId: POINT_ID } });
    accepts(SimulationRequest, {
      target: { kind: 'draft', pointId: POINT_ID, draft: draftInput() },
    });
  });

  it('rejects a bad target, an invalid carried draft and extras', () => {
    rejects(SimulationRequest, {});
    rejects(SimulationRequest, { target: { kind: 'release', routingReleaseId: 'nope' } });
    rejects(SimulationRequest, {
      target: { kind: 'draft', pointId: POINT_ID, draft: { name: 'x' } },
    });
    rejects(SimulationRequest, { target: release, surprise: 1 });
    rejects(SimulationRequest, { target: { ...release, pointId: POINT_ID } });
  });

  it('rejects bad caller ids, clocks, variables and too many turns', () => {
    rejects(SimulationRequest, { target: release, call: { from: '9812345678' } });
    rejects(SimulationRequest, { target: release, call: { to: '+0123' } });
    rejects(SimulationRequest, { target: release, call: { at: 'tomorrow' } });
    rejects(SimulationRequest, { target: release, call: { variables: { '1bad': 'x' } } });
    rejects(SimulationRequest, { target: release, call: { variables: { a: 'x'.repeat(201) } } });
    rejects(SimulationRequest, {
      target: release,
      call: {
        variables: Object.fromEntries(
          Array.from({ length: SIMULATION_LIMITS.variables + 1 }, (_, i) => [`v${i}`, 'x']),
        ),
      },
    });
    rejects(SimulationRequest, {
      target: release,
      turns: Array.from({ length: SIMULATION_LIMITS.turns + 1 }, () => ({ kind: 'silence' })),
    });
    rejects(SimulationRequest, { target: release, load: 'maybe' });
    rejects(SimulationRequest, { target: release, engines: { mode: { llm: 'real' } } });
    rejects(SimulationRequest, { target: release, assume: { transferEnabled: 'yes' } });
  });
});
