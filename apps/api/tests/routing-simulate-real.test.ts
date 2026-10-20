import { describe, expect, it } from 'vitest';
import { RoutingEvalRun, RoutingSimulationResult } from '@winsendotai/ovo-contracts';
import { routerSimulator } from '../src/routing-simulator.ts';
import { POOL_SALES, draftInput } from './routing-fixtures.ts';
import { publishPoint, r4Setup } from './routing-sim-fixtures.ts';

/**
 * The routes against the router package that is installed, not a scripted one: the glue between
 * them (the target resolved like publish, the flags, the clock, the claim load, the router
 * release's disclosure) is what is checked here. It skips where the installed router predates R4.
 */
const simulator = routerSimulator();
const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const viewer = { 'x-role': 'viewer' };

/** The worked example with the classifier asked for the caller's language, so a Hindi caller can be scripted. */
function draft() {
  const input = draftInput();
  input.nodes[0].engines[1].detectLanguage = true;
  return input;
}

describe.skipIf(!simulator)('the route tester against the real router (R4)', () => {
  async function ready() {
    const built = await r4Setup({ simulator: simulator!, clock: () => NOW });
    const made = await publishPoint(built.call, draft());
    const run = (body: Record<string, unknown>) =>
      built.call('POST', '/v1/routing/simulate', {
        target: { kind: 'release', routingReleaseId: made.release.id },
        ...body,
      });
    return { ...built, ...made, run };
  }
  const answer = (extra: Record<string, unknown> = {}) => ({
    node: 'intent',
    engine: 'llm',
    branch: 'sales',
    confidence: 0.9,
    ...extra,
  });

  it('routes a scripted English caller to the English sales member', async () => {
    const { run } = await ready();
    const response = await run({
      turns: [{ kind: 'speech', text: 'I want to buy a card' }],
      engines: { answers: [answer({ language: 'en' })] },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = RoutingSimulationResult.parse(response.json());
    expect(body.outcome).toMatchObject({
      status: 'agent',
      node: 'intent',
      path: ['intent'],
      language: 'en',
      context: { intent: 'sales' },
      agent: { agentId: 'sales-en', poolId: POOL_SALES, memberId: 'sales-en' },
      degraded: null,
    });
    expect(body.outcome.completionReason).toBe('route:agent:intent');
    expect(body.turns.map((turn) => turn.input.kind)).toEqual(['opening', 'speech']);
    expect(body.turns[0]!.say).toContain('Welcome to Acme');
    expect(body.engineModes).toEqual({
      rules: 'real',
      decision: 'mock',
      llm: 'mock',
      external: 'mock',
    });
    expect(body.at).toBe('2026-10-20T10:00:00.000Z');
    expect(body.source.kind).toBe('release');
  });

  it('routes a Hindi caller to the Hindi member, and a keypad press with no engine at all', async () => {
    const { run } = await ready();
    const hindi = RoutingSimulationResult.parse(
      (
        await run({
          turns: [{ kind: 'speech', text: 'mujhe naya card chahiye' }],
          engines: { answers: [answer({ language: 'hi' })] },
        })
      ).json(),
    );
    expect(hindi.outcome).toMatchObject({
      status: 'agent',
      language: 'hi',
      agent: { memberId: 'sales-hi' },
    });
    const keypad = RoutingSimulationResult.parse(
      (await run({ turns: [{ kind: 'dtmf', digits: '1' }] })).json(),
    );
    expect(keypad.outcome).toMatchObject({ status: 'agent', agent: { poolId: POOL_SALES } });
    expect(
      keypad.turns[1]!.steps.some(
        (step) => step.type === 'route.node' && step.payload.engine === 'rules',
      ),
    ).toBe(true);
  });

  it('warns when an engine had no scripted answer, and falls back as the router does', async () => {
    const { run } = await ready();
    const body = RoutingSimulationResult.parse(
      (
        await run({
          turns: [
            { kind: 'speech', text: 'hello there' },
            { kind: 'speech', text: 'hello again' },
          ],
        })
      ).json(),
    );
    expect(body.warnings.map((warning) => warning.code)).toContain('engine_unscripted');
    const fallbacks = body.turns
      .flatMap((turn) => turn.steps)
      .filter((step) => step.type === 'route.fallback');
    expect(fallbacks.map((step) => step.payload.step)).toEqual(['reask', 'default']);
    // The default step sends the caller to the point's default agent.
    expect(body.outcome).toMatchObject({ status: 'agent', agent: { agentId: 'sales-en' } });
  });

  it('is deterministic for a fixed clock, and reads the draft target the same way', async () => {
    const { run, call, point } = await ready();
    const request = {
      call: { at: '2026-10-21T04:30:00.000Z', from: '+919812345678' },
      turns: [{ kind: 'speech', text: 'sales' }],
      engines: { answers: [answer()] },
    };
    const first = (await run(request)).body;
    expect(first).toBe((await run(request)).body);
    const draftRun = RoutingSimulationResult.parse(
      (
        await call('POST', '/v1/routing/simulate', {
          ...request,
          target: { kind: 'draft', pointId: point.id },
        })
      ).json(),
    );
    expect(draftRun.outcome.status).toBe('agent');
    expect(draftRun.warnings.map((warning) => warning.code)).toEqual([
      'draft_unpublished',
      'clock_overridden',
    ]);
  });

  it('feeds the live claim load to the ranking', async () => {
    const { run, routing } = await ready();
    // Two English-speaking members in one pool: the busier one is passed over.
    routing.activeClaims[POOL_SALES] = { 'sales-en': 5 };
    const body = RoutingSimulationResult.parse(
      (
        await run({
          turns: [{ kind: 'speech', text: 'sales' }],
          engines: { answers: [answer({ language: 'en' })] },
          load: 'live',
        })
      ).json(),
    );
    expect(body.pools[0]).toMatchObject({ poolId: POOL_SALES, result: 'picked' });
    expect(body.pools[0]!.members.find((member) => member.memberId === 'sales-en')).toMatchObject({
      active: 5,
    });
  });

  it('explains a pool with the router own eligibility', async () => {
    const { call } = await ready();
    const explained = await call(
      'POST',
      '/v1/routing/pools/explain',
      { poolId: POOL_SALES, context: { language: 'hi' } },
      viewer,
    );
    expect(explained.statusCode, explained.body).toBe(200);
    const body = explained.json();
    expect(
      body.members.map((member: { memberId: string; eligible: boolean }) => [
        member.memberId,
        member.eligible,
      ]),
    ).toEqual([
      ['sales-en', false],
      ['sales-hi', true],
    ]);
    expect(body.members[0].reasons).toContain('language');
    expect(body.result).toBe('picked');
  });

  it('scores a corpus with the real scorer and keeps the run', async () => {
    const { call, release } = await ready();
    const created = await call('POST', '/v1/routing/eval-runs', {
      routingReleaseId: release.id,
      name: 'Worked example',
      cases: [
        {
          id: 'sales-keypad',
          turns: [{ kind: 'dtmf', digits: '1' }],
          expect: { status: 'agent', node: 'intent', pool: 'Sales' },
        },
        {
          id: 'sales-hindi',
          turns: [{ kind: 'speech', text: 'naya card' }],
          answers: [answer({ language: 'hi' })],
          expect: {
            status: 'agent',
            member: 'sales-hi',
            language: 'hi',
            branches: { intent: 'sales' },
          },
        },
        {
          id: 'wrong-on-purpose',
          turns: [{ kind: 'dtmf', digits: '1' }],
          expect: { status: 'end' },
        },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const run = RoutingEvalRun.parse(created.json());
    expect(run.scorecard.totals).toEqual({ cases: 3, passed: 2, failed: 1 });
    expect(run.scorecard.failures.map((failure) => failure.id)).toEqual(['wrong-on-purpose']);
    expect(run.scorecard.routing.digest).toBe(release.digest);
    expect(run.scorecard.engineMode).toBe('recorded');
    expect(run.headline).toMatchObject({ passed: 2, total: 3 });
  });
});
