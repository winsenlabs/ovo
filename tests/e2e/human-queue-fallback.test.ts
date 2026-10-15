import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACD_NUMBER } from './support/fake-acd.ts';
import { HUMAN_LINES, holdPolicy, humanStack, type HumanStack } from './support/human-setup.ts';
import { at, hungUpByPlatform, of } from './support/human-call.ts';
import { LINES } from './support/routing-setup.ts';
import { heard, said, transferCall } from './support/transfer-call.ts';
import { SUMMARY, TRANSFER_LINES } from './support/transfer-setup.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  const { routedLookup } = await import('./support/routed-net.ts');
  return { ...actual, lookup: routedLookup(actual.lookup as never, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error('The human-queue-fallback test needs OVO_TEST_POSTGRES_URL');

describe('external human queue: when the third party cannot connect the caller (R3)', () => {
  let env: HumanStack;
  beforeAll(async () => {
    env = await humanStack(postgresUrl!, net.routes, {
      line: { external: { hold: holdPolicy(5) }, transfer: true },
    });
  }, 180_000);
  afterAll(async () => env?.close());

  /** A call from the router that falls to the desk queue and ends on a platform line. */
  const routerCall = (act?: Parameters<typeof transferCall>[1]) =>
    transferCall(
      env,
      act ??
        (async (call) => {
          await heard(env, call, LINES.greeting);
          env.stt.say('I have a strange question');
          await hungUpByPlatform(env, call);
        }),
      { carrier: 'hangup' },
    );
  const webhooks = (events: Parameters<typeof of>[0]) =>
    of(events, 'human.webhook').map((event) => event.payload.outcome);

  it('3a. three 503s fail the delivery and the hold chain returns the caller to its agent', async () => {
    env.openAi.answer({ branch: 'sales', confidence: 0.9, language: 'en' });
    env.openAi.transfer('sales-en', {
      target: 'colleague',
      summary: SUMMARY,
      reason: 'asked for a person',
    });
    env.acd.reply({ status: 503 }, { status: 503 }, { status: 503 });
    const before = env.acd.requests.length;
    const result = await transferCall(env, async (call) => {
      await heard(env, call, LINES.greeting);
      env.stt.say('I want to buy a card');
      await heard(env, call, HUMAN_LINES.sales);
      env.stt.say('Please put me through to a person');
      await said(env, call, TRANSFER_LINES.returned);
    });
    const sent = env.acd.requests.slice(before);
    // Three attempts of one delivery: the same request id and idempotency key, an exponential
    // backoff (500 ms then 1 s, minus 20 % jitter at most), each attempt signed on its own.
    expect(sent.map((request) => request.attempt)).toEqual([1, 2, 3]);
    expect(new Set(sent.map((request) => request.idempotencyKey)).size).toBe(1);
    expect(new Set(sent.map((request) => request.requestId)).size).toBe(1);
    expect(sent.every((request) => request.signature === 'valid')).toBe(true);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(400);
    expect(sent[2]!.at - sent[1]!.at).toBeGreaterThanOrEqual(800);
    // The transferring agent's summary reached the third party through the mapped body only.
    expect(sent[0]!.json.notes).toContain(SUMMARY);
    expect(JSON.stringify(result.events)).not.toContain(SUMMARY);
    const { events } = result;
    expect(webhooks(events)).toEqual(['retry', 'retry', 'failed']);
    at(events, 'human.state', { state: 'released', code: 'webhook_failed' });
    at(events, 'human.completed', { outcome: 'unavailable' });
    at(events, 'route.segment', {
      role: 'agent',
      reason: 'return',
      agentId: of(events, 'route.segment')[1]!.payload.agentId,
    });
    const completed = at(events, 'transfer.completed', {
      outcome: 'returned',
      reason: 'webhook_failed',
    });
    expect(events[completed]!.payload.steps).toEqual([{ step: 'return', result: 'taken' }]);
    expect(result.summary.transfers).toMatchObject({ requested: 1, connected: 0, failed: 1 });
    expect(result.summary.human).toMatchObject({ outcome: 'unavailable', queueKey: 'desk' });
    // The caller stayed on the one leg the whole time: nothing was ever dialled.
    expect(result.carrierRequests.some((request) => request.body.includes('Twiml'))).toBe(false);
  });

  it('3b. a queued caller nobody calls back about times out, the third party is told, and the callback promise ends the call', async () => {
    env.acd.reply({ status: 200, json: { result: 'queued', ref: 'ACD-1' } });
    const before = env.acd.requests.length;
    const result = await routerCall();
    const { events } = result;
    expect(webhooks(events)).toEqual(['delivered', 'queued', 'cancelled_sent']);
    at(events, 'human.state', { state: 'released', code: 'timed_out' });
    const completed = at(events, 'human.completed', { outcome: 'timeout' });
    expect(Number(events[completed]!.payload.waitMs)).toBeGreaterThanOrEqual(5_000);
    // The best-effort cancel is one signed post, never retried, naming the ticket.
    const sent = env.acd.requests.slice(before);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.signature).toBe('valid');
    expect(sent[1]!.json).toMatchObject({
      schema: 'ovo.human-queue/1',
      event: 'cancelled',
      queue: { key: 'desk' },
    });
    expect(result.summary).toMatchObject({
      outcome: 'completed',
      disposition: 'callback',
      dispositionSource: 'system',
    });
    expect(result.summary.human).toMatchObject({ outcome: 'timeout', requested: 1 });
    // The platform hung up after speaking: the carrier saw exactly one hang-up.
    expect(result.carrierRequests.map((request) => request.body)).toEqual(['Status=completed']);
  });

  it('3c. a destination outside the allow-list is never dialled and the chain continues', async () => {
    env.acd.reply({ status: 200, json: { result: 'ok', dial: { number: '+919999999999' } } });
    const result = await routerCall();
    const { events } = result;
    expect(webhooks(events)).toEqual(['delivered', 'accepted', 'failed', 'cancelled_sent']);
    const refused = at(events, 'human.webhook', { outcome: 'failed' });
    expect(events[refused]!.payload.reason).toBe('destination_refused:e164_prefix');
    at(events, 'human.state', { state: 'released', code: 'webhook_rejected' });
    at(events, 'human.completed', { outcome: 'rejected' });
    expect(result.summary).toMatchObject({ outcome: 'completed', disposition: 'callback' });
    // The only thing the carrier was asked to do is hang up after the promise: no <Dial> at all.
    expect(result.carrierRequests.map((request) => request.body)).toEqual(['Status=completed']);
    expect(JSON.stringify(result.carrierRequests)).not.toContain('9999999999');
  });

  it('3d. a carrier that refuses the handoff leaves the caller on the line and the chain continues', async () => {
    env.acd.reply({ status: 200, json: { result: 'ok', dial: { number: ACD_NUMBER } } });
    env.twilioRest.behavior.refuse = 400;
    try {
      const result = await routerCall();
      const { events } = result;
      at(events, 'human.state', { state: 'released', code: 'abandoned' });
      at(events, 'human.completed', { outcome: 'failed' });
      at(events, 'segment.ended', {
        role: 'human',
        ended: 'start_failed',
        endReason: 'start_failed',
      });
      expect(result.summary).toMatchObject({ outcome: 'completed', disposition: 'callback' });
      // Two carrier requests: the refused handoff, then the hang-up after the callback promise.
      const [handoff, hangup] = result.carrierRequests;
      expect(new URLSearchParams(handoff!.body).get('Twiml')).toContain(
        `<Number>${ACD_NUMBER}</Number>`,
      );
      expect(hangup!.body).toBe('Status=completed');
      expect(hangup!.at).toBeGreaterThanOrEqual(handoff!.at);
    } finally {
      delete env.twilioRest.behavior.refuse;
    }
  });
});
