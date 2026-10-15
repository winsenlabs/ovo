import { describe, expect, it } from 'vitest';
import { EXAMPLE_IDS as I } from '../src/testing.ts';
import { dtmf, idle, opening, routerHarness } from './harness.ts';

const GREETING = 'Welcome to Acme. How can I help you today?';
const ASK = 'Is it about buying something new, or an existing account?';

describe('router behaviour: opening', () => {
  it('speaks first with the greeting and owns caller silence', async () => {
    const h = routerHarness();
    expect(h.behavior.speaksFirst()).toBe(true);
    expect(h.behavior.idleTimeoutMs()).toBe(8000);
    expect((await h.turn('', opening)).say).toBe(GREETING);
    expect(h.events).toEqual([]);
    expect(h.behavior.isComplete()).toBe(false);
  });

  it('decides on the opening when an instant engine can (a caller-id rule)', async () => {
    const h = routerHarness({
      host: { call: { from: '+919800000001' } },
      patch: (raw) =>
        raw.nodes[0].engines.unshift({
          kind: 'rules',
          rules: [{ branch: 'sales', when: [{ kind: 'caller-id', prefixes: ['+9198'] }] }],
        }),
    });
    expect((await h.turn('', opening)).say).toBe('Connecting you now.');
    expect(h.handoff.committed).toEqual(['handoff-1']);
    expect(h.of('route.node')).toEqual([
      {
        turn: 0,
        node: 'intent',
        engine: 'rules',
        outcome: 'matched',
        branch: 'sales',
        confidence: 1,
        ms: 0,
      },
    ]);
    expect(h.of('route.decision')[0]).toMatchObject({
      turns: 0,
      target: 'agent',
      memberId: 'sales-en',
    });
  });

  it('greets idle-time without running an engine that needs the caller', async () => {
    const h = routerHarness();
    await h.turn('', opening);
    expect(h.engines.calls).toEqual([]);
  });
});

describe('router behaviour: caller turns', () => {
  it('routes a keypad turn by rules, claims a member and prepares, commits and announces', async () => {
    const h = routerHarness();
    await h.turn('', opening);
    const { say } = await h.turn('1', dtmf('1'));
    expect(say).toBe('Connecting you now.');
    expect(h.handoff.prepared).toEqual([
      {
        kind: 'agent',
        reason: 'route',
        agentId: 'sales-en',
        releaseId: I.salesEn,
        variables: { ovo_route_intent: 'sales' },
        route: {
          path: ['intent'],
          poolId: I.salesPool,
          memberId: 'sales-en',
          claimId: '00000000-0000-4000-8000-000000000001',
        },
      },
    ]);
    expect(h.handoff.committed).toEqual(['handoff-1']);
    expect(h.core.phase).toBe('announcing');
    expect(h.of('route.decision')).toEqual([
      {
        routingPointId: h.host.call.routingPointId,
        routingReleaseId: h.host.call.routingReleaseId,
        path: ['intent'],
        target: 'agent',
        agentId: 'sales-en',
        releaseId: I.salesEn,
        poolId: I.salesPool,
        memberId: 'sales-en',
        context: { intent: 'sales' },
        turns: 1,
        routeMs: 0,
      },
    ]);
  });

  it('routes speech through the LLM in the caller language, with the Hindi member and line', async () => {
    const h = routerHarness({
      script: {
        intent: {
          llm: [{ outcome: 'matched', branch: 'sales', confidence: 0.91, language: 'hi' }],
        },
      },
    });
    await h.turn('', opening);
    expect((await h.turn('mujhe naya credit card chahiye')).say).toBe(
      'आपकी कॉल अभी जोड़ी जा रही है।',
    );
    expect(h.handoff.prepared[0]).toMatchObject({
      releaseId: I.salesHi,
      variables: { ovo_route_language: 'hi', ovo_route_intent: 'sales' },
    });
    expect(h.of('route.decision')[0]).toMatchObject({ language: 'hi', memberId: 'sales-hi' });
    expect(h.engines.calls[1]!.input.turn).toEqual({ text: 'mujhe naya credit card chahiye' });
  });

  it('asks the next node, then routes on its answer by product', async () => {
    const h = routerHarness({
      script: { intent: { llm: [{ outcome: 'matched', branch: 'support', confidence: 0.8 }] } },
    });
    await h.turn('', opening);
    expect((await h.turn('I have a problem')).say).toBe('Is it about a card or a loan?');
    expect((await h.turn('the loan one')).say).toBe('Connecting you now.');
    expect(h.handoff.prepared[0]).toMatchObject({
      releaseId: I.supportLoans,
      route: { path: ['intent', 'product'] },
    });
    expect(h.core.completionReason()).toBe('route:agent:intent>product');
  });

  it('re-asks once, then takes the default step to the release default agent', async () => {
    const h = routerHarness({
      script: {
        intent: { llm: [{ outcome: 'low_confidence', confidence: 0.2 }, { outcome: 'no_match' }] },
      },
    });
    await h.turn('', opening);
    expect((await h.turn('umm')).say).toBe(ASK);
    expect((await h.turn('err')).say).toBe('Connecting you now.');
    expect(h.handoff.prepared[0]).toMatchObject({ agentId: 'sales-en', releaseId: I.salesEn });
    expect(h.handoff.prepared[0]).toHaveProperty('route', { path: ['intent'] });
    expect(h.of('route.fallback')).toEqual([
      { turn: 1, node: 'intent', step: 'reask', result: 'taken', attempt: 1 },
      { turn: 2, node: 'intent', step: 'default', result: 'taken', attempt: 1 },
    ]);
  });

  it('skips the re-ask and moves on when the chosen target cannot be prepared', async () => {
    let calls = 0;
    const h = routerHarness({
      handoff: {
        prepare: () =>
          ++calls === 1 ? { ok: false, reason: 'compose_failed' } : { ok: true, handoffId: 'h2' },
      },
    });
    await h.turn('', opening);
    expect((await h.turn('1', dtmf('1'))).say).toBe('Connecting you now.');
    expect(h.of('route.fallback')).toEqual([
      {
        turn: 1,
        node: 'intent',
        step: 'reask',
        result: 'skipped',
        attempt: 1,
        reason: 'compose_failed',
      },
      { turn: 1, node: 'intent', step: 'default', result: 'taken', attempt: 1 },
    ]);
    expect(h.handoff.committed).toEqual(['h2']);
  });

  it('records a member taken without a claim when claim storage is down', async () => {
    const h = routerHarness({
      host: {
        claim: (tiers) => ({
          kind: 'unclaimed',
          candidate: tiers[0]![0]!,
          reason: 'claims_unavailable',
        }),
      },
    });
    await h.turn('', opening);
    await h.turn('1', dtmf('1'));
    expect(h.handoff.prepared[0]).toHaveProperty('route', {
      path: ['intent'],
      poolId: I.salesPool,
      memberId: 'sales-en',
    });
    expect(h.of('route.decision')[0]).toMatchObject({ degraded: 'claims_unavailable' });
  });
});

describe('router behaviour: limits and silence', () => {
  it('sends the call to the release default past maxTurns', async () => {
    const h = routerHarness({
      patch: (raw) => {
        raw.limits = { maxTurns: 2, maxRouteSeconds: 90 };
        raw.nodes[0].fallback = [
          { kind: 'reask', times: 3 },
          { kind: 'end', line: { en: 'Bye.' } },
        ];
      },
    });
    await h.turn('', opening);
    expect((await h.turn('umm')).say).toBe(ASK);
    expect((await h.turn('umm')).say).toBe(ASK);
    expect((await h.turn('umm')).say).toBe('Connecting you now.');
    expect(h.of('route.fallback').slice(-2)).toEqual([
      { turn: 3, node: 'intent', step: 'limit', result: 'taken', attempt: 1, reason: 'max_turns' },
      { turn: 3, node: 'intent', step: 'release_default', result: 'taken', attempt: 1 },
    ]);
    expect(h.engines.calls.filter((call) => call.kind === 'llm')).toHaveLength(2);
  });

  it('sends the call to the release default past maxRouteSeconds, on the fake clock', async () => {
    const h = routerHarness();
    await h.turn('', opening);
    expect((await h.turn('umm')).say).toBe(ASK);
    h.host.advance(91_000);
    expect((await h.turn('sales please')).say).toBe('Connecting you now.');
    expect(h.of('route.fallback').at(-2)).toMatchObject({
      step: 'limit',
      reason: 'max_route_seconds',
    });
    expect(h.of('route.decision')[0]).toMatchObject({ routeMs: 91_000, turns: 2 });
  });

  it('speaks the idle prompts in order, then runs the node fallback as a no-input turn', async () => {
    const h = routerHarness();
    await h.turn('', opening);
    expect((await h.turn('', idle)).say).toBe('Are you still there?');
    expect((await h.turn('', idle)).say).toBe(ASK);
    expect((await h.turn('', idle)).say).toBe('Connecting you now.');
    expect(h.engines.calls).toEqual([]);
    expect(h.of('route.fallback').map((event) => event.step)).toEqual(['reask', 'default']);
  });

  it('starts the idle prompts again after the caller speaks', async () => {
    const h = routerHarness({
      patch: (raw) => (raw.nodes[0].fallback = [{ kind: 'reask', times: 3 }, { kind: 'default' }]),
    });
    await h.turn('', opening);
    await h.turn('', idle);
    await h.turn('umm');
    expect((await h.turn('', idle)).say).toBe('Are you still there?');
  });
});
