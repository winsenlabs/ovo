import {
  RoutingEngine,
  type RoutingEngineKind,
  type SegmentHandoffRequest,
} from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { resultOf } from '../src/simulate/answers.ts';
import { createSimHandoff } from '../src/simulate/handoff.ts';
import { createSimClock, createSimHost, memberKey } from '../src/simulate/host.ts';
import { SimulatedAnswer, SimulationFaults } from '../src/wire/index.ts';
import { exampleRoutingSnapshot, EXAMPLE_IDS as I } from '../src/testing.ts';
import { NOON } from './support-sim.ts';
import { deskSnapshot } from './support-human.ts';

const engine = (kind: RoutingEngineKind, over: Record<string, unknown> = {}) =>
  RoutingEngine.parse(
    {
      rules: { kind, rules: [{ branch: 'a', when: [{ kind: 'dtmf', digits: '1' }] }] },
      decision: { kind, instructions: 'Why?', ...over },
      llm: { kind, instructions: 'Why?', ...over },
      external: { kind, endpoint: 'https://x.example.com/d', credentialId: 'c', ...over },
    }[kind],
  );
const answer = (over: Record<string, unknown>) =>
  SimulatedAnswer.parse({ node: 'intent', engine: 'llm', ...over });

describe('resultOf: what the real engine would have reported for a scripted answer', () => {
  it.each([
    ['decision', 0.7, 'matched'],
    ['decision', 0.69, 'low_confidence'],
    ['llm', 0.6, 'matched'],
    ['llm', 0.59, 'low_confidence'],
    ['external', 0.5, 'matched'],
    ['external', 0.49, 'low_confidence'],
  ] as const)('%s at %s is %s (each engine has its own threshold)', (kind, confidence, outcome) => {
    expect(resultOf(answer({ engine: kind, branch: 'a', confidence }), engine(kind))).toEqual({
      outcome,
      branch: 'a',
      confidence,
    });
  });

  it('honours a threshold the node sets', () => {
    expect(
      resultOf(answer({ branch: 'a', confidence: 0.8 }), engine('llm', { threshold: 0.9 })).outcome,
    ).toBe('low_confidence');
    expect(
      resultOf(answer({ branch: 'a', confidence: 0.8 }), engine('llm', { threshold: 0.8 })).outcome,
    ).toBe('matched');
  });

  it('keeps only what the engine could have produced', () => {
    const rich = {
      branch: 'a',
      confidence: 0.2,
      language: 'hi',
      clarify: 'Which?',
      slots: { product: 'cards' },
      reason: 'because',
    };
    expect(resultOf(answer(rich), engine('llm'))).toEqual({
      outcome: 'low_confidence',
      branch: 'a',
      confidence: 0.2,
      reason: 'because',
    });
    expect(
      resultOf(answer(rich), engine('llm', { detectLanguage: true, generatedClarify: true })),
    ).toMatchObject({
      language: 'hi',
      clarify: 'Which?',
    });
    // A matched verdict never speaks a clarifying question; a webhook's slots are its allow-list.
    expect(
      resultOf(answer({ ...rich, confidence: 0.9 }), engine('llm', { generatedClarify: true })),
    ).not.toHaveProperty('clarify');
    expect(
      resultOf(
        answer({ ...rich, engine: 'external', confidence: 0.9 }),
        engine('external', { slots: ['product'] }),
      ),
    ).toMatchObject({
      outcome: 'matched',
      slots: { product: 'cards' },
    });
    expect(
      resultOf(answer({ ...rich, engine: 'external', confidence: 0.9 }), engine('external')),
    ).not.toHaveProperty('slots');
  });

  it('drops the branch from an outcome that names none', () => {
    expect(resultOf(answer({ branch: 'a', outcome: 'timeout' }), engine('llm'))).toEqual({
      outcome: 'timeout',
    });
    expect(resultOf(answer({ outcome: 'disabled', reason: 'off' }), engine('external'))).toEqual({
      outcome: 'disabled',
      reason: 'off',
    });
  });

  it('reads an absent branch as the engine would', () => {
    expect(resultOf(answer({}), engine('llm')).outcome).toBe('low_confidence');
    expect(resultOf(answer({ engine: 'decision' }), engine('decision')).outcome).toBe('no_match');
    expect(resultOf(answer({ engine: 'external', branch: null }), engine('external')).outcome).toBe(
      'no_match',
    );
  });
});

describe('the simulated host', () => {
  const candidate = (memberId: string, capacity?: number) => ({
    poolId: I.salesPool,
    memberId,
    agentId: memberId,
    releaseId: I.salesEn,
    ...(capacity ? { capacity } : {}),
  });
  const host = (load: Record<string, number> = {}, full: string[] = []) =>
    createSimHost({
      clock: createSimClock(NOON),
      call: {
        callId: 'c',
        workspaceId: 'w',
        routingPointId: I.routingPoint,
        routingReleaseId: 'r',
        variables: {},
      },
      load,
      full: new Set(full),
    });
  const signal = new AbortController().signal;

  it('claims the least loaded member of the first tier with room, and never claims twice the same id', async () => {
    const h = host({ [memberKey(I.salesPool, 'a')]: 3 });
    const first = await h.claim([[candidate('a'), candidate('b')], [candidate('c')]], signal);
    const second = await h.claim([[candidate('c')]], signal);
    expect(first).toMatchObject({ kind: 'claimed', candidate: { memberId: 'b' } });
    expect(second).toMatchObject({ kind: 'claimed', candidate: { memberId: 'c' } });
    expect((first as { claimId: string }).claimId).not.toBe(
      (second as { claimId: string }).claimId,
    );
  });

  it('moves to the next tier when the first is at capacity or faulted, and is full when none has room', async () => {
    const h = host({ [memberKey(I.salesPool, 'a')]: 1 }, [memberKey(I.salesPool, 'b')]);
    expect(
      await h.claim([[candidate('a', 1), candidate('b')], [candidate('c')]], signal),
    ).toMatchObject({ candidate: { memberId: 'c' } });
    expect(await h.claim([[candidate('a', 1), candidate('b')]], signal)).toEqual({ kind: 'full' });
    expect(await h.claim([], signal)).toEqual({ kind: 'full' });
  });

  it('keeps the clock still until it is moved, and reports a disabled external by default', async () => {
    const clock = createSimClock(NOON);
    clock.advance(1500);
    clock.advance(-5);
    expect(clock.now() - clock.start).toBe(1500);
    await expect(host().external({} as never, signal)).rejects.toMatchObject({ kind: 'disabled' });
  });
});

describe('the simulated handoff port', () => {
  const agentRequest = (releaseId: string): SegmentHandoffRequest => ({
    kind: 'agent',
    reason: 'route',
    agentId: 'sales-en',
    releaseId,
    variables: {},
  });
  const port = (
    over: {
      snapshot?: ReturnType<typeof exampleRoutingSnapshot>;
      faults?: object;
      transfer?: boolean;
      human?: boolean;
    } = {},
  ) =>
    createSimHandoff({
      snapshot: over.snapshot ?? exampleRoutingSnapshot(),
      host: createSimHost({
        clock: createSimClock(NOON),
        call: {
          callId: 'c',
          workspaceId: 'w',
          routingPointId: I.routingPoint,
          routingReleaseId: 'r',
          variables: {},
        },
        load: {},
        full: new Set(),
      }),
      faults: SimulationFaults.parse(over.faults ?? {}),
      transferEnabled: over.transfer ?? true,
      humanQueueEnabled: over.human ?? true,
    });
  const signal = new AbortController().signal;

  it('offers begin only when transfers are assumed on, as the worker does', () => {
    expect(port({ transfer: true })).toHaveProperty('begin');
    expect(port({ transfer: false })).not.toHaveProperty('begin');
  });

  it('prepares an agent, refuses a failed release with the fault code, and refuses what prepare cannot do', async () => {
    const faults = { failedReleases: [{ releaseId: I.salesHi, reason: 'timeout' }] };
    const p = port({ faults, transfer: false });
    expect(await p.prepare(agentRequest(I.salesEn), signal)).toEqual({
      ok: true,
      handoffId: 'sim-handoff-1',
    });
    expect(await p.prepare(agentRequest(I.salesHi), signal)).toEqual({
      ok: false,
      reason: 'timeout',
    });
    expect(
      await p.prepare({ kind: 'human', reason: 'route', queueId: 'desk', variables: {} }, signal),
    ).toEqual({ ok: false, reason: 'unsupported' });
    expect(p.records.map((r) => r.result)).toEqual(['ok', 'timeout', 'unsupported']);
  });

  it('begins an agent and a queue request, and refuses a node re-route, which only the worker can do', async () => {
    const tiers = [
      [{ poolId: I.salesPool, memberId: 'sales-en', agentId: 'sales-en', releaseId: I.salesEn }],
    ];
    const queue: SegmentHandoffRequest = {
      kind: 'queue',
      reason: 'route',
      poolId: I.salesPool,
      tiers,
      variables: {},
    };
    const reroute: SegmentHandoffRequest = {
      kind: 'node',
      reason: 'transfer',
      node: 'intent',
      variables: {},
      transfer: { source: 'router' },
    };
    expect(await port().begin!(agentRequest(I.salesEn), signal)).toMatchObject({
      ok: true,
      state: 'preparing',
    });
    // A queue request claims again; with room it begins like an agent (full pools are covered by the run tests).
    expect(await port().begin!(queue, signal)).toMatchObject({ ok: true, state: 'preparing' });
    expect(await port().begin!(reroute, signal)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('answers a human request in the worker precheck order: feature, binding, hours, faults', async () => {
    const human = (queueId: string): SegmentHandoffRequest => ({
      kind: 'human',
      reason: 'route',
      queueId,
      variables: {},
    });
    expect(
      await port({ snapshot: deskSnapshot(), human: false }).begin!(human('desk'), signal),
    ).toEqual({ ok: false, reason: 'queue_unavailable' });
    expect(await port({ snapshot: deskSnapshot() }).begin!(human('ghost'), signal)).toEqual({
      ok: false,
      reason: 'queue_unknown',
    });
    expect(
      await port({ snapshot: deskSnapshot(), faults: { queues: { desk: 'no_operators' } } }).begin!(
        human('desk'),
        signal,
      ),
    ).toEqual({ ok: false, reason: 'no_operators' });
    expect(await port({ snapshot: deskSnapshot() }).begin!(human('desk'), signal)).toMatchObject({
      ok: true,
    });
  });
});
