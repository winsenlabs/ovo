import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresOperationsService } from '../../packages/plugin-operations/src/index.ts';
import { LINES } from './support/routing-setup.ts';
import {
  at,
  heard,
  holding,
  receivedAudio,
  said,
  transferCall,
  transferStack,
  type SessionEvent,
  type TransferStack,
} from './support/transfer-call.ts';
import { SUMMARY, TRANSFER_LINES, UNDECLARED } from './support/transfer-setup.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

/**
 * The fake composition knob (design 13.3): a release listed in `slow` composes that much later,
 * one in `broken` fails to compose, so a test can force a hold or a timeout chain. `landed` lists
 * the releases whose composition has finished.
 */
const knob = vi.hoisted(() => ({
  slow: new Map<string, number>(),
  broken: new Set<string>(),
  landed: new Set<string>(),
}));
vi.mock('../../apps/worker/src/routed-segments.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/worker/src/routed-segments.ts')>();
  return {
    ...actual,
    routedSegmentComposer(...args: Parameters<typeof actual.routedSegmentComposer>) {
      const compose = actual.routedSegmentComposer(...args);
      return async (...call: Parameters<typeof compose>) => {
        const releaseId = call[0].releaseId;
        await new Promise((resolve) => setTimeout(resolve, knob.slow.get(releaseId) ?? 0));
        if (knob.broken.has(releaseId)) throw new Error(`e2e knob: ${releaseId} fails to compose`);
        const segment = await compose(...call);
        knob.landed.add(releaseId);
        return segment;
      };
    },
  };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl)
  throw new Error('The transfer-path test needs OVO_TEST_POSTGRES_URL (it creates schemas)');
/** The worker's R2 transfer runtime (worker lane); until it lands these scenarios cannot run. */
const transferRuntime = existsSync(
  new URL('../../apps/worker/src/transfer-controller.ts', import.meta.url),
);

const clearKnob = () => [knob.slow, knob.broken, knob.landed].forEach((set) => set.clear());
const of = (events: SessionEvent[], type: string) => events.filter((event) => event.type === type);
const count = (haystack: Buffer, needle: Buffer) => {
  let found = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) found++;
  return found;
};

/** Router → sales-en: the caller asks in English, the classifier picks sales. */
async function toSalesEn(
  env: TransferStack,
  call: Parameters<Parameters<typeof transferCall>[1]>[0],
) {
  env.openAi.answer({ branch: 'sales', confidence: 0.9, language: 'en' });
  await heard(env, call, LINES.greeting);
  env.stt.say('I want to talk about my credit card bill');
  await heard(env, call, LINES.salesEn);
}

describe.skipIf(!transferRuntime)('in-call agent transfer on one carrier leg (R2)', () => {
  let env: TransferStack;

  beforeAll(async () => {
    env = await transferStack(postgresUrl!, net.routes, { transfer: true }, { billingCapacity: 1 });
  }, 180_000);
  afterAll(async () => env?.close());
  afterEach(clearKnob);

  it('1. warm transfer with hold: announcement, clip and line, then billing greets with the summary', async () => {
    const { line } = env;
    knob.slow.set(line.billing.releaseId, 4_000);
    env.openAi.transfer('sales-en', {
      target: 'billing',
      summary: SUMMARY,
      reason: 'double charge',
    });
    const result = await transferCall(env, async (call) => {
      await toSalesEn(env, call);
      env.stt.say('I was double charged and want my money back');
      await heard(env, call, TRANSFER_LINES.announcement);
      await heard(env, call, TRANSFER_LINES.holdLine);
      await heard(env, call, TRANSFER_LINES.billing);
    });
    const { events } = result;
    const requested = at(events, 'transfer.requested', {
      transfer: 1,
      fromSegment: 1,
      source: 'llm',
      key: 'billing',
      result: 'accepted',
    });
    const ended = at(events, 'segment.ended', { index: 1, ended: 'handoff' });
    const segment = at(events, 'route.segment', { index: 2, reason: 'transfer', transfer: 1 });
    const completed = at(events, 'transfer.completed', { transfer: 1, outcome: 'connected' });
    expect(requested < ended && ended < segment && segment < completed).toBe(true);
    expect(Number(events[completed]!.payload.holdMs)).toBeGreaterThan(2_000);
    // The hold clip reached the caller (and with it the recording tap) between the two agents.
    expect(count(result.audio, line.pattern), 'hold clip bytes heard').toBeGreaterThan(0);
    // The handover reached billing's LLM inside its data section, with declared variables only.
    const billing = env.openAi.requests.filter((request) => request.agent === 'billing');
    expect(billing.length).toBeGreaterThan(0);
    expect(billing[0]!.body).toContain(SUMMARY);
    expect(billing.some((request) => request.body.includes(UNDECLARED))).toBe(false);
    // Free text never reaches events.
    expect(JSON.stringify(events)).not.toContain(SUMMARY);
    expect(result.summary.route).toMatchObject({
      agentId: line.salesEn.agentId,
      releaseId: line.salesEn.releaseId,
      segments: 3,
    });
    expect(result.summary.transfers).toEqual({ requested: 1, refused: 0, connected: 1, failed: 0 });
    expect(
      result.summary.segments.map((s: { index: number; reason: string }) => [s.index, s.reason]),
    ).toEqual([
      [0, 'start'],
      [1, 'route'],
      [2, 'transfer'],
    ]);
    expect(result.usageSegments).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(result.claims.map((claim) => claim.member_id)).toEqual(['sales-en', 'billing-1']);
    expect(result.claims.every((claim) => claim.released_at instanceof Date)).toBe(true);
  }, 180_000);

  it('2. queue: a full billing pool holds until a seat frees, and returns the caller when none does', async () => {
    const { line, stack } = env;
    const operations = new PostgresOperationsService({
      pool: stack.db,
      organizationId: stack.variables.OVO_ORGANIZATION_ID!,
    });
    const seat = {
      poolId: line.pools.billing,
      memberId: 'billing-1',
      agentId: line.billing.agentId,
      releaseId: line.billing.releaseId,
      capacity: 1,
    };
    const block = (callId: string) =>
      operations.routing.claims.claim({
        callId,
        routingReleaseId: line.routingReleaseId,
        ttlSeconds: 300,
        tiers: [[seat]],
      });
    expect((await block('blocker-1')).kind).toBe('claimed');
    env.openAi.transfer('sales-en', { target: 'billing', summary: SUMMARY });
    const queued = await transferCall(env, async (call) => {
      await toSalesEn(env, call);
      env.stt.say('I need billing please');
      await said(env, call, TRANSFER_LINES.queue);
      await operations.routing.claims.release('blocker-1');
      await heard(env, call, TRANSFER_LINES.billing);
    });
    at(queued.events, 'transfer.requested', { key: 'billing', result: 'accepted', queued: true });
    const done = at(queued.events, 'transfer.completed', { outcome: 'connected' });
    expect(Number(queued.events[done]!.payload.queueMs)).toBeGreaterThan(0);

    expect((await block('blocker-2')).kind).toBe('claimed');
    env.openAi.transfer('sales-en', { target: 'billing', summary: SUMMARY });
    const returned = await transferCall(env, async (call) => {
      await toSalesEn(env, call);
      env.stt.say('I need billing please');
      await said(env, call, TRANSFER_LINES.queue);
      await heard(env, call, TRANSFER_LINES.returned);
    });
    await operations.routing.claims.release('blocker-2');
    at(returned.events, 'route.segment', { reason: 'return', releaseId: line.salesEn.releaseId });
    at(returned.events, 'transfer.completed', { outcome: 'returned' });
    expect(returned.summary.transfers).toMatchObject({ connected: 0, failed: 1 });
  }, 180_000);

  it('3. refusals: billing cannot send the caller back to sales (ping-pong) and keeps talking', async () => {
    env.openAi.transfer('sales-en', { target: 'billing', summary: SUMMARY });
    env.openAi.transfer('billing', { target: 'sales', summary: 'Wants to buy a new card.' });
    const result = await transferCall(env, async (call) => {
      await toSalesEn(env, call);
      env.stt.say('I was double charged');
      await heard(env, call, TRANSFER_LINES.billing);
      const spoken = env.openAi.speech.length;
      env.stt.say('actually I want to buy a new card instead');
      await vi.waitFor(() => expect(env.openAi.speech.length).toBeGreaterThan(spoken), {
        timeout: 20_000,
      });
    });
    at(result.events, 'transfer.requested', {
      key: 'sales',
      result: 'refused',
      refusal: 'ping_pong',
    });
    expect(result.summary.transfers).toEqual({ requested: 2, refused: 1, connected: 1, failed: 0 });
    expect(of(result.events, 'route.segment')).toHaveLength(3);
  }, 180_000);

  it('4. re-route: sales hands the caller back to the router, which picks the Hindi member', async () => {
    const { line } = env;
    env.openAi.transfer('sales-en', { target: 'another_language', summary: 'Prefers Hindi.' });
    const result = await transferCall(env, async (call) => {
      await toSalesEn(env, call);
      env.openAi.answer({ branch: 'sales', confidence: 0.95, language: 'hi' });
      env.stt.say('can we speak in Hindi please');
      await heard(env, call, LINES.ask);
      env.stt.say('mujhe hindi mein baat karni hai');
      await heard(env, call, LINES.salesHi);
    });
    const reroute = at(result.events, 'route.segment', {
      index: 2,
      role: 'router',
      reason: 'reroute',
    });
    const hindi = at(result.events, 'route.segment', {
      index: 3,
      role: 'agent',
      reason: 'transfer',
      releaseId: line.salesHi.releaseId,
    });
    expect(reroute < hindi).toBe(true);
    // The Hindi member's STT opened in Hindi, whatever the segments before it heard.
    expect(decodeURIComponent(env.stt.sessions.at(-1)!.url)).toContain('"hi"');
    expect(result.summary.transfers.connected).toBe(1);
  }, 180_000);

  it("6. the router's own handoff holds a slow agent and falls back to the default when it fails", async () => {
    const { line } = env;
    knob.slow.set(line.salesEn.releaseId, 4_000);
    const held = await transferCall(env, async (call) => {
      env.openAi.answer({ branch: 'sales', confidence: 0.9, language: 'en' });
      await heard(env, call, LINES.greeting);
      env.stt.say('I want to buy a card');
      await holding(call, line.pattern);
      await heard(env, call, LINES.salesEn);
    });
    expect(count(held.audio, line.pattern)).toBeGreaterThan(0);
    knob.slow.clear();
    knob.broken.add(line.salesEn.releaseId);
    const fellBack = await transferCall(env, async (call) => {
      env.openAi.answer({ branch: 'sales', confidence: 0.9, language: 'en' });
      await heard(env, call, LINES.greeting);
      env.stt.say('I want to buy a card');
      await heard(env, call, LINES.fallback);
    });
    // R1 audit gap 3: the outcome names the agent that actually answered.
    expect(fellBack.summary.route).toMatchObject({
      agentId: line.fallback.agentId,
      releaseId: line.fallback.releaseId,
    });
  }, 180_000);

  it('7. a caller hanging up during hold ends the transfer cleanly', async () => {
    const { line } = env;
    knob.slow.set(line.billing.releaseId, 30_000);
    env.openAi.transfer('sales-en', { target: 'billing', summary: SUMMARY });
    const result = await transferCall(env, async (call, hangUp) => {
      await toSalesEn(env, call);
      const before = receivedAudio(call).length;
      env.stt.say('billing please');
      await holding(call, line.pattern, before);
      await hangUp();
    });
    at(result.events, 'transfer.completed', { outcome: 'caller_hangup' });
    expect(of(result.events, 'route.segment')).toHaveLength(2);
    expect(result.claims.every((claim) => claim.released_at instanceof Date)).toBe(true);
    expect(result.summary.transfers).toMatchObject({ connected: 0, failed: 0 });
  }, 180_000);
});

describe.skipIf(!transferRuntime)('transfer limits and disclosure once per call (R2)', () => {
  let env: TransferStack;

  beforeAll(async () => {
    env = await transferStack(
      postgresUrl!,
      net.routes,
      { transfer: true },
      { maxTransfers: 1, disclosures: true },
    );
  }, 180_000);
  afterAll(async () => env?.close());

  it('5. says the recording disclosure once and only the AI part after the handoff; 3. stops at maxTransfers', async () => {
    env.openAi.transfer('sales-en', { target: 'billing', summary: SUMMARY });
    env.openAi.transfer('billing', { target: 'senior', summary: 'Wants a senior colleague.' });
    const result = await transferCall(env, async (call) => {
      await toSalesEn(env, call);
      env.stt.say('I was double charged');
      await heard(env, call, TRANSFER_LINES.billing);
      const spoken = env.openAi.speech.length;
      env.stt.say('let me speak to someone senior');
      await vi.waitFor(() => expect(env.openAi.speech.length).toBeGreaterThan(spoken), {
        timeout: 20_000,
      });
    });
    const recorded = env.openAi.speech.filter((text) => text.includes(TRANSFER_LINES.recorded));
    expect(recorded, 'the recording disclosure is said once per call').toHaveLength(1);
    expect(env.openAi.speech.some((text) => text.includes(TRANSFER_LINES.ai))).toBe(true);
    const disclosed = of(result.events, 'disclosure').map((event) => event.payload);
    expect(disclosed).toEqual([
      expect.objectContaining({ kinds: ['recording'], segment: 0 }),
      expect.objectContaining({ kinds: ['ai'], segment: 1 }),
    ]);
    // maxTransfers 1 is used up: billing is no longer offered transfer_to_agent (the worker's
    // port grants no targets once the call is exhausted), so the LLM carries on talking.
    const billing = env.openAi.requests.filter((request) => request.agent === 'billing');
    expect(billing.length).toBeGreaterThan(0);
    expect(billing.some((request) => request.tools.includes('transfer_to_agent'))).toBe(false);
    expect(of(result.events, 'transfer.requested')).toHaveLength(1);
  }, 180_000);
});

describe.skipIf(!transferRuntime)('OVO_ROUTING_TRANSFER_ENABLED=false (R2 ships dark)', () => {
  let env: TransferStack;

  beforeAll(async () => {
    env = await transferStack(postgresUrl!, net.routes, { transfer: false });
  }, 180_000);
  afterAll(async () => env?.close());

  it('3. never offers transfer_to_agent and runs the routed call exactly as R1', async () => {
    env.openAi.transfer('sales-en', { target: 'billing', summary: SUMMARY });
    const result = await transferCall(env, async (call) => {
      await toSalesEn(env, call);
      env.stt.say('I was double charged');
      await heard(env, call, 'Sure, let me check that for you.');
    });
    const offered = env.openAi.requests.filter((request) =>
      request.tools.includes('transfer_to_agent'),
    );
    expect(offered).toEqual([]);
    expect(
      result.events.filter((event) => /^(transfer|segment)\.|^disclosure$/.test(event.type)),
    ).toEqual([]);
    expect(result.summary.transfers).toEqual({ requested: 0, refused: 0, connected: 0, failed: 0 });
    expect(result.usageSegments).toEqual([null]);
    expect(count(result.audio, env.line.pattern)).toBe(0);
  }, 180_000);
});

/**
 * At the production prepare bound (2.5 s), the router picks sales-en, whose graph composes in 4 s:
 * the default agent answers, and the sales graph landing later is disposed without ending the
 * call the default agent is serving (R2 audit gap 1; R1's late path too, transfers off).
 */
describe.each([
  ['transfers on', true],
  ['transfers off (R1)', false],
])('a graph landing after the default prepare bound (%s)', (_name, transfer) => {
  let env: TransferStack;

  beforeAll(async () => {
    env = await transferStack(postgresUrl!, net.routes, { transfer, defaultBound: true });
  }, 180_000);
  afterAll(async () => env?.close());
  afterEach(clearKnob);

  it.skipIf(!transferRuntime)(
    'leaves the call to the agent that answered',
    async () => {
      const { line } = env;
      knob.slow.set(line.salesEn.releaseId, 4_000);
      const result = await transferCall(env, async (call) => {
        env.openAi.answer({ branch: 'sales', confidence: 0.9, language: 'en' });
        await heard(env, call, LINES.greeting);
        env.stt.say('I want to buy a card');
        await said(env, call, LINES.fallback);
        await vi.waitFor(() => expect(knob.landed).toContain(line.salesEn.releaseId), {
          timeout: 15_000,
        });
        // The late graph opened its own STT session and closes it as it is disposed, a moment after
        // its composition lands. `say` speaks on the newest open session, so wait for the disposal
        // and speak on the one session left: the one the default agent is listening on.
        await vi.waitFor(() => expect(env.stt.open()).toHaveLength(1), { timeout: 15_000 });
        const listening = env.stt.open()[0]!;
        // The default agent still hears the caller and answers after the late graph is gone.
        const asked = env.openAi.requests.length;
        env.stt.sayOn(listening, 'Are you still there?');
        await vi.waitFor(
          () =>
            expect(
              env.openAi.requests.slice(asked).some((request) => request.agent === 'fallback'),
            ).toBe(true),
          { timeout: 20_000 },
        );
      });
      expect(of(result.events, 'session.failed')).toEqual([]);
      expect(result.summary.route).toMatchObject({
        agentId: line.fallback.agentId,
        releaseId: line.fallback.releaseId,
      });
    },
    180_000,
  );
});
