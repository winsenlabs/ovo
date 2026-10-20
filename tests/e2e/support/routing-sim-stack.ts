import { expect, vi } from 'vitest';
import { startFakeTwilioRest } from './fake-providers.ts';
import { FakeTwilioCall } from './fake-twilio-caller.ts';
import { carrierUrls, configureInboundAgent, operatorApi } from './operator-setup.ts';
import { startRoutingOpenAi, startScriptedAssemblyAi } from './routing-fakes.ts';
import { startLiveStack, type LiveStack } from './stack.ts';

export type RouteEvent = { type: string; payload: Record<string, unknown> };

/**
 * One installation (api, gateway, dispatcher, worker) with routing on and the fake providers on
 * loopback. `routes` is the test's hoisted host table (the `ovo.net` replacement reads it).
 */
export async function routingSimStack(postgresUrl: string, routes: Map<string, string>) {
  const openAi = await startRoutingOpenAi('Sure, I can help with that.');
  const stt = await startScriptedAssemblyAi();
  const twilioRest = await startFakeTwilioRest();
  routes.set('api.openai.com', openAi.server.origin);
  routes.set('streaming.assemblyai.com', stt.server.origin);
  routes.set('api.twilio.com', twilioRest.server.origin);
  const stack = await startLiveStack(postgresUrl, { OVO_ROUTING_ENABLED: 'true' });
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
    async close() {
      await stack.close();
      await Promise.all([openAi, stt, twilioRest].map((fake) => fake.server.close()));
    },
  };
}
export type RoutingSimStack = Awaited<ReturnType<typeof routingSimStack>>;

/** Waits until the router has spoken `line` and its audio has finished reaching the caller. */
export async function heard(env: RoutingSimStack, call: FakeTwilioCall, line: string) {
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

/**
 * Rings the number, lets `act` drive the router, waits for `opening` from the chosen agent, hangs
 * up, and returns the `route.*` events the call recorded (the same events the inspector shows).
 */
export async function routedCall(
  env: RoutingSimStack,
  act: (call: FakeTwilioCall) => Promise<void>,
  opening: string,
): Promise<RouteEvent[]> {
  const { stack, agent } = env;
  const urls = await carrierUrls(stack.operator, agent.twilioBindingId);
  const call = new FakeTwilioCall(stack.gateway, agent, { from: CALLER, to: agent.number });
  try {
    const answer = await call.ring(urls.voice);
    expect(answer.status).toBe(200);
    await call.connect(answer.twiml);
    await act(call);
    await vi.waitFor(() => expect(env.openAi.speech).toContain(opening), {
      timeout: 30_000,
      interval: 100,
    });
    expect(await call.hangUp(urls.status)).toBe(204);
  } finally {
    call.close();
  }
  const legs = await stack.db.query<{ job_id: string }>(
    'SELECT job_id FROM ovo_session_routes WHERE carrier_call_id = $1',
    [call.callSid],
  );
  expect(legs.rows, 'one carrier leg, one session route').toHaveLength(1);
  const jobId = legs.rows[0]!.job_id;
  let events: RouteEvent[] = [];
  await vi.waitFor(
    async () => {
      const outcome = await operatorApi(stack.operator)<{ events: RouteEvent[] }>(
        'GET',
        `/v1/calls/${jobId}/outcome`,
      );
      expect(outcome.events.some((event) => event.type === 'call.outcome')).toBe(true);
      events = outcome.events.filter((event) => event.type.startsWith('route.'));
    },
    { timeout: 20_000, interval: 250 },
  );
  return events;
}

/** The caller id every parity call rings from, so the simulation can be given the same one. */
export const CALLER = '+919800000001';

/** A POST to `/v1/routing/simulate`, or undefined while this build has no such endpoint. */
export async function simulateOverApi(
  stack: LiveStack,
  body: object,
): Promise<unknown | undefined> {
  try {
    return await operatorApi(stack.operator)('POST', '/v1/routing/simulate', body);
  } catch (error) {
    if (String(error).includes('returned 404')) return undefined;
    throw error;
  }
}
