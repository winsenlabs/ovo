import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeTwilioRest } from './support/fake-providers.ts';
import { FakeTwilioCall } from './support/fake-twilio-caller.ts';
import {
  carrierUrls,
  configureInboundAgent,
  operatorApi,
  type InboundAgent,
} from './support/operator-setup.ts';
import { startRoutingOpenAi, startScriptedAssemblyAi } from './support/routing-fakes.ts';
import {
  bindRoutedLineDirectly,
  configureRoutedLine,
  LINES,
  type RoutedLine,
} from './support/routing-setup.ts';
import { startLiveStack, type LiveStack } from './support/stack.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl)
  throw new Error(
    'The routing-path test needs OVO_TEST_POSTGRES_URL (a database it may create schemas in)',
  );

type RouteEvent = { type: string; payload: Record<string, unknown> };
interface Outcome {
  summary: { route: Record<string, unknown> | null } | null;
  events: RouteEvent[];
}

/** One installation (api, gateway, dispatcher, worker) with fake providers on loopback. */
async function routingStack(routingEnabled: boolean) {
  const openAi = await startRoutingOpenAi('Sure, I can help with that.');
  const stt = await startScriptedAssemblyAi();
  const twilioRest = await startFakeTwilioRest();
  net.routes.set('api.openai.com', openAi.server.origin);
  net.routes.set('streaming.assemblyai.com', stt.server.origin);
  net.routes.set('api.twilio.com', twilioRest.server.origin);
  const stack = await startLiveStack(postgresUrl!, {
    OVO_ROUTING_ENABLED: String(routingEnabled),
  });
  const agent = await configureInboundAgent(stack.operator);
  await vi.waitFor(
    () => {
      if (stack.worker.status.state === 'failed') throw new Error(stack.worker.status.detail);
      expect(stack.worker.status.state).toBe('ready');
    },
    { timeout: 30_000, interval: 100 },
  );
  await vi.waitFor(
    async () => {
      const capacity = await operatorApi(stack.operator)<{ readyProtected: number }>(
        'GET',
        '/v1/operations/inbound/capacity',
      );
      expect(capacity.readyProtected).toBeGreaterThanOrEqual(1);
    },
    { timeout: 15_000, interval: 250 },
  );
  return {
    stack,
    agent,
    openAi,
    stt,
    twilioRest,
    async close() {
      await stack.close();
      await Promise.all([openAi, stt, twilioRest].map((fake) => fake.server.close()));
    },
  };
}
type RoutingStack = Awaited<ReturnType<typeof routingStack>>;

/**
 * Rings the number, lets `act` drive the router, waits for `opening` from the chosen agent, then
 * hangs up and returns what the call left behind. Throughout, the one carrier leg and the one
 * media stream must stay up and the carrier must never be asked to hang up.
 */
async function routedCall(
  env: RoutingStack,
  act: (call: FakeTwilioCall) => Promise<void>,
  opening: string,
) {
  const { stack, agent } = env;
  const reservationsBefore = await count(stack, 'SELECT count(*) FROM ovo_cost_reservations');
  const urls = await carrierUrls(stack.operator, agent.twilioBindingId);
  const call = new FakeTwilioCall(stack.gateway, agent, {
    from: '+919800000001',
    to: agent.number,
  });
  try {
    const answer = await call.ring(urls.voice);
    expect(answer.status).toBe(200);
    await call.connect(answer.twiml);
    await act(call);
    await vi
      .waitFor(() => expect(env.openAi.speech).toContain(opening), {
        timeout: 30_000,
        interval: 100,
      })
      .catch(async (error: unknown) => {
        // What the router did instead, for the failure message.
        const events = await stack.db.query(
          `SELECT e.type, e.payload FROM ovo_session_events e
           JOIN ovo_session_routes r ON r.job_id::text = e.call_id
           WHERE r.carrier_call_id = $1 ORDER BY e.sequence`,
          [call.callSid],
        );
        throw new Error(
          `${String(error)}; spoken ${JSON.stringify(env.openAi.speech)}; classifier ` +
            `${env.openAi.classifierRequests()}; events ${JSON.stringify(events.rows)}`,
        );
      });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(call.connected, 'the media stream closed during the handoff').toBe(true);
    // The REST API may still be finishing an earlier call; only this call's requests count.
    expect(
      env.twilioRest.requests.filter((request) => request.url.includes(call.callSid)),
      'the carrier was asked to hang up',
    ).toEqual([]);
    expect(await call.hangUp(urls.status)).toBe(204);
  } finally {
    call.close();
  }
  const legs = await stack.db.query<{ job_id: string; session_id: string }>(
    'SELECT job_id, session_id FROM ovo_session_routes WHERE carrier_call_id = $1',
    [call.callSid],
  );
  expect(legs.rows, 'one carrier leg, one session route').toHaveLength(1);
  const { job_id: jobId, session_id: sessionId } = legs.rows[0]!;
  await vi.waitFor(
    async () => {
      const job = await stack.db.query<{ status: string }>(
        'SELECT status FROM ovo_jobs WHERE id = $1',
        [jobId],
      );
      expect(job.rows[0]?.status).toBe('completed');
    },
    { timeout: 20_000 },
  );
  expect(
    await count(
      stack,
      "SELECT count(*) FROM ovo_carrier_callbacks WHERE session_id = $1 AND status = 'session_opened'",
      [sessionId],
    ),
    'one media stream for the whole call',
  ).toBe(1);
  expect(await count(stack, 'SELECT count(*) FROM ovo_cost_reservations')).toBe(
    reservationsBefore + 1,
  );
  let outcome!: Outcome;
  await vi.waitFor(
    async () => {
      outcome = await operatorApi(stack.operator)<Outcome>('GET', `/v1/calls/${jobId}/outcome`);
      expect(outcome.events.some((event) => event.type === 'call.outcome')).toBe(true);
    },
    { timeout: 20_000, interval: 250 },
  );
  const claims = await stack.db.query<{ released_at: Date | null }>(
    'SELECT released_at FROM ovo_routing_member_claims WHERE call_id = $1',
    [jobId],
  );
  const job = await stack.db.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM ovo_jobs WHERE id = $1',
    [jobId],
  );
  return {
    jobId,
    claims: claims.rows,
    payload: job.rows[0]!.payload,
    route: outcome.events.filter((event) => event.type.startsWith('route.')),
    summary: outcome.summary,
  };
}

async function count(stack: LiveStack, sql: string, values: unknown[] = []): Promise<number> {
  return Number((await stack.db.query<{ count: string }>(sql, values)).rows[0]!.count);
}

/** Waits until the router has spoken `line` and its audio has finished reaching the caller. */
async function heard(env: RoutingStack, call: FakeTwilioCall, line: string) {
  await vi.waitFor(() => expect(env.openAi.speech).toContain(line), {
    timeout: 20_000,
    interval: 100,
  });
  let bytes = -1;
  await vi.waitFor(
    () => {
      const now = call.agentAudioBytes;
      const settled = now > 0 && now === bytes;
      bytes = now;
      expect(settled, 'the line is still playing').toBe(true);
    },
    { timeout: 15_000, interval: 700 },
  );
}

/** The position of the first route event matching `where`; -1 fails the ordering checks. */
function at(events: RouteEvent[], type: string, where: Record<string, unknown> = {}): number {
  const index = events.findIndex(
    (event) =>
      event.type === type &&
      Object.entries(where).every(([key, value]) => event.payload[key] === value),
  );
  expect(
    index,
    `${type} ${JSON.stringify(where)} in ${JSON.stringify(events)}`,
  ).toBeGreaterThanOrEqual(0);
  return index;
}

describe('routed inbound calls: router segment, then the chosen agent on the same leg', () => {
  let env: RoutingStack;
  let line: RoutedLine;

  beforeAll(async () => {
    env = await routingStack(true);
    line = await configureRoutedLine(env.stack.operator, env.agent);
  }, 120_000);
  afterAll(async () => env?.close());

  it('routes a Hindi caller to the Hindi sales member with the LLM classifier', async () => {
    env.openAi.answer({ branch: 'sales', confidence: 0.9, language: 'hi' });
    const result = await routedCall(
      env,
      async (call) => {
        await heard(env, call, LINES.greeting);
        env.stt.say('mujhe naya credit card chahiye');
      },
      LINES.salesHi,
    );
    const events = result.route;
    const start = at(events, 'route.segment', { index: 0, role: 'router', reason: 'start' });
    const matched = at(events, 'route.node', {
      engine: 'llm',
      outcome: 'matched',
      branch: 'sales',
    });
    const decision = at(events, 'route.decision', { target: 'agent', memberId: 'sales-hi' });
    const handoff = at(events, 'route.segment', {
      index: 1,
      role: 'agent',
      releaseId: line.salesHi.releaseId,
    });
    expect(start < matched && matched < decision && decision < handoff).toBe(true);
    expect(result.summary?.route).toMatchObject({
      routingPointId: line.routingPointId,
      routingReleaseId: line.routingReleaseId,
      path: ['intent'],
      target: 'agent',
      agentId: line.salesHi.agentId,
      releaseId: line.salesHi.releaseId,
      poolId: line.salesPoolId,
      memberId: 'sales-hi',
      language: 'hi',
      degraded: null,
      segments: 2,
    });
    expect(result.payload).toMatchObject({
      releaseId: line.router.releaseId,
      routing: {
        routingReleaseId: line.routingReleaseId,
        defaultReleaseId: line.fallback.releaseId,
      },
    });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.released_at).toBeInstanceOf(Date);
    expect(env.openAi.speech).not.toContain(LINES.salesEn);
  }, 120_000);

  it('routes a keypad 2 to support by rules alone, without asking the LLM', async () => {
    const classifier = env.openAi.classifierRequests();
    const result = await routedCall(
      env,
      async (call) => {
        await heard(env, call, LINES.greeting);
        call.pressDigit('2');
      },
      LINES.support,
    );
    expect(env.openAi.classifierRequests()).toBe(classifier);
    const events = result.route;
    const matched = at(events, 'route.node', {
      engine: 'rules',
      outcome: 'matched',
      branch: 'support',
    });
    const decision = at(events, 'route.decision', { target: 'agent', memberId: 'support' });
    const handoff = at(events, 'route.segment', {
      index: 1,
      role: 'agent',
      releaseId: line.support.releaseId,
    });
    expect(
      at(events, 'route.segment', { index: 0 }) < matched &&
        matched < decision &&
        decision < handoff,
    ).toBe(true);
    expect(result.summary?.route).toMatchObject({
      target: 'agent',
      poolId: line.supportPoolId,
      memberId: 'support',
      segments: 2,
    });
    expect(result.claims.map((claim) => claim.released_at)).toEqual([expect.any(Date)]);
  }, 120_000);

  it('re-asks once on a low-confidence answer, then hands the call to the release default', async () => {
    env.openAi.answer({ branch: null, confidence: 0.2 }, { branch: 'sales', confidence: 0.3 });
    const result = await routedCall(
      env,
      async (call) => {
        await heard(env, call, LINES.greeting);
        env.stt.say('umm I am not sure');
        await heard(env, call, LINES.ask);
        env.stt.say('maybe something else');
      },
      LINES.fallback,
    );
    const events = result.route;
    const first = at(events, 'route.node', { engine: 'llm', outcome: 'low_confidence' });
    const reask = at(events, 'route.fallback', { step: 'reask', result: 'taken' });
    const fallback = at(events, 'route.fallback', { step: 'default', result: 'taken' });
    const decision = at(events, 'route.decision', {
      target: 'agent',
      releaseId: line.fallback.releaseId,
    });
    const handoff = at(events, 'route.segment', {
      index: 1,
      role: 'agent',
      releaseId: line.fallback.releaseId,
    });
    expect(first < reask && reask < fallback && fallback < decision && decision < handoff).toBe(
      true,
    );
    expect(
      events.filter(
        (event) => event.type === 'route.node' && event.payload.outcome === 'low_confidence',
      ),
    ).toHaveLength(2);
    expect(result.summary?.route).toMatchObject({
      target: 'agent',
      agentId: line.fallback.agentId,
      releaseId: line.fallback.releaseId,
      poolId: null,
      memberId: null,
      segments: 2,
    });
    // A direct default target takes no claim.
    expect(result.claims.every((claim) => claim.released_at instanceof Date)).toBe(true);
  }, 120_000);
});

describe('routing kill switch: OVO_ROUTING_ENABLED=false with the number still bound', () => {
  let env: RoutingStack;
  let line: RoutedLine;
  let base: InboundAgent;

  beforeAll(async () => {
    env = await routingStack(false);
    base = env.agent;
    line = await bindRoutedLineDirectly(
      env.stack.operator,
      base,
      env.stack.db,
      env.stack.variables.OVO_ORGANIZATION_ID!,
    );
  }, 120_000);
  afterAll(async () => env?.close());

  it('answers with the default agent directly, with no router segment', async () => {
    const result = await routedCall(env, async () => undefined, LINES.fallback);
    expect(env.openAi.speech).not.toContain(LINES.greeting);
    expect(env.openAi.classifierRequests()).toBe(0);
    expect(result.payload.releaseId).toBe(line.fallback.releaseId);
    expect(result.payload).not.toHaveProperty('routing');
    expect(result.route).toEqual([]);
    expect(result.summary?.route ?? null).toBeNull();
    expect(result.claims).toEqual([]);
    const admission = await env.stack.db.query<{
      detail: Record<string, unknown>;
      routing_release_id: string;
    }>('SELECT detail, routing_release_id FROM ovo_ops_inbound_admissions WHERE job_id = $1', [
      result.jobId,
    ]);
    expect(admission.rows[0]).toMatchObject({
      routing_release_id: line.routingReleaseId,
      detail: { routingDisabled: true },
    });
  }, 120_000);
});
