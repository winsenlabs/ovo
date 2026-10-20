import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoutingReleaseSnapshot } from '../../packages/contracts/src/index.ts';
import {
  simulateRoute,
  SimulationRequest,
  type RoutingSimulationResult,
} from '../../packages/plugin-router/src/index.ts';
import { operatorApi } from './support/operator-setup.ts';
import { LINES, configureRoutedLine, type RoutedLine } from './support/routing-setup.ts';
import { project, stepsAsEvents } from './support/routing-sim-project.ts';
import {
  CALLER,
  heard,
  routedCall,
  routingSimStack,
  simulateOverApi,
  type RoutingSimStack,
} from './support/routing-sim-stack.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl)
  throw new Error(
    'The routing-simulate-parity test needs OVO_TEST_POSTGRES_URL (a database it may create schemas in)',
  );

/*
 * R4 design 5.5.3: the simulator is the router the worker runs, driven with mock engines. A real
 * routed call (scripted STT and classifier, real PostgreSQL, one carrier leg) and a simulation of
 * the same published release with equivalent mock answers must make the same decisions: the same
 * route.node / route.fallback sequence and the same decision target and member. The simulation
 * runs twice: through simulateRoute directly, and through POST /v1/routing/simulate once the API
 * has it (the build without it skips that half).
 */
describe('a real routed call and its simulation decide the same', () => {
  let env: RoutingSimStack;
  let line: RoutedLine;
  let snapshot: RoutingReleaseSnapshot;

  beforeAll(async () => {
    env = await routingSimStack(postgresUrl, net.routes);
    line = await configureRoutedLine(env.stack.operator, env.agent);
    const release = await operatorApi(env.stack.operator)<{ snapshot: unknown }>(
      'GET',
      `/v1/routing/releases/${line.routingReleaseId}`,
    );
    snapshot = RoutingReleaseSnapshot.parse(release.snapshot);
  }, 120_000);
  afterAll(async () => env?.close());

  /** The simulation both ways, projected like the call's events. */
  async function simulated(body: {
    turns: object[];
    answers?: object[];
  }): Promise<{ direct: ReturnType<typeof project>; api?: ReturnType<typeof project> }> {
    const request = {
      call: { from: CALLER, to: env.agent.number },
      turns: body.turns,
      engines: { answers: body.answers ?? [] },
    };
    const direct = await simulateRoute({
      snapshot,
      request: SimulationRequest.omit({ target: true }).parse(request),
      now: Date.now(),
      router: {},
      flags: { transferEnabled: false, humanQueueEnabled: false },
    });
    const over = (await simulateOverApi(env.stack, {
      ...request,
      target: { kind: 'release', routingReleaseId: line.routingReleaseId },
    })) as RoutingSimulationResult | undefined;
    return {
      direct: project(stepsAsEvents(direct)),
      ...(over ? { api: project(stepsAsEvents(over)) } : {}),
    };
  }

  const agrees = (real: ReturnType<typeof project>, sim: Awaited<ReturnType<typeof simulated>>) => {
    expect(sim.direct, 'simulateRoute').toEqual(real);
    if (sim.api) expect(sim.api, 'POST /v1/routing/simulate').toEqual(real);
    else
      process.stderr.write(
        'routing-simulate-parity: this build has no POST /v1/routing/simulate\n',
      );
  };

  it('a Hindi caller, classified as sales: the same verdicts, the same member', async () => {
    env.openAi.answer({ branch: 'sales', confidence: 0.9, language: 'hi' });
    const text = 'mujhe naya credit card chahiye';
    const real = project(
      await routedCall(
        env,
        async (call) => {
          await heard(env, call, LINES.greeting);
          env.stt.say(text);
        },
        LINES.salesHi,
      ),
    );
    expect(real.at(-1)).toMatchObject({
      type: 'route.decision',
      target: 'agent',
      memberId: 'sales-hi',
    });
    agrees(
      real,
      await simulated({
        turns: [{ kind: 'speech', text }],
        answers: [
          { node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.9, language: 'hi' },
        ],
      }),
    );
  }, 120_000);

  it('keypad 2: rules alone decide support, and no model is asked in either', async () => {
    const asked = env.openAi.classifierRequests();
    const real = project(
      await routedCall(
        env,
        async (call) => {
          await heard(env, call, LINES.greeting);
          call.pressDigit('2');
        },
        LINES.support,
      ),
    );
    expect(env.openAi.classifierRequests()).toBe(asked);
    expect(real.at(-1)).toMatchObject({ target: 'agent', memberId: 'support' });
    agrees(real, await simulated({ turns: [{ kind: 'dtmf', digits: '2' }] }));
  }, 120_000);

  it('two unsure answers: one re-ask, then the release default, with no member', async () => {
    env.openAi.answer({ branch: null, confidence: 0.2 }, { branch: 'sales', confidence: 0.3 });
    const real = project(
      await routedCall(
        env,
        async (call) => {
          await heard(env, call, LINES.greeting);
          env.stt.say('umm I am not sure');
          await heard(env, call, LINES.ask);
          env.stt.say('maybe something else');
        },
        LINES.fallback,
      ),
    );
    expect(real.map((event) => event.type)).toContain('route.fallback');
    expect(real.at(-1)).toMatchObject({ target: 'agent', releaseId: line.fallback.releaseId });
    agrees(
      real,
      await simulated({
        turns: [
          { kind: 'speech', text: 'umm I am not sure' },
          { kind: 'speech', text: 'maybe something else' },
        ],
        answers: [
          { node: 'intent', engine: 'llm', branch: null, confidence: 0.2 },
          { node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.3 },
        ],
      }),
    );
  }, 120_000);
});
