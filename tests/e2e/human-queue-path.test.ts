import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signedCallback, ACD_NUMBER } from './support/fake-acd.ts';
import {
  ACD_SECRET,
  CALLER_NUMBER,
  HUMAN_LINES,
  humanStack,
  type HumanStack,
} from './support/human-setup.ts';
import {
  at,
  carrierUpdate,
  deliveries,
  of,
  outcomeOf,
  postCallback,
  ticketOf,
  twimlOf,
} from './support/human-call.ts';
import { LINES } from './support/routing-setup.ts';
import { heard, said, transferCall } from './support/transfer-call.ts';

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
if (!postgresUrl) throw new Error('The human-queue-path test needs OVO_TEST_POSTGRES_URL');

describe('external human queue (R3)', () => {
  let env: HumanStack;
  beforeAll(async () => {
    env = await humanStack(postgresUrl!, net.routes);
  }, 180_000);
  afterAll(async () => env?.close());

  it('1. sync happy path: one signed delivery with policy-on fields only, then the carrier moves the leg', async () => {
    env.acd.reply({
      delayMs: 3_500,
      status: 200,
      json: { result: 'ok', dial: { number: ACD_NUMBER } },
    });
    const before = env.acd.requests.length;
    const result = await transferCall(
      env,
      async (call) => {
        await heard(env, call, LINES.greeting);
        env.stt.say('I have a strange question');
        await heard(env, call, HUMAN_LINES.announcement);
        await said(env, call, HUMAN_LINES.hold);
        const update = await carrierUpdate(env, call);
        expect(twimlOf(update)).toBe(
          `<Response><Dial><Number>${ACD_NUMBER}</Number></Dial></Response>`,
        );
      },
      { carrier: 'handoff' },
    );
    const sent = env.acd.requests.slice(before);
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request!.signature).toBe('valid');
    expect(request!.idempotencyKey).toMatch(/^hq:/);
    expect(Math.abs(Date.now() / 1000 - Number(request!.headers['x-ovo-timestamp']))).toBeLessThan(
      60,
    );
    expect(request!.json).toMatchObject({
      callId: result.jobId,
      lang: 'en',
      ref: request!.idempotencyKey,
    });
    // Only what the queue's policy allows: no caller number, no transcript, no called number.
    expect(request!.body).not.toContain(CALLER_NUMBER);
    expect(request!.body).not.toContain(agentNumber(env));
    expect(request!.body.toLowerCase()).not.toContain('transcript');
    const { events } = result;
    const requested = at(events, 'human.requested', { kind: 'external', queue: 'desk' });
    const delivered = at(events, 'human.webhook', { outcome: 'delivered', attempt: 1 });
    const accepted = at(events, 'human.webhook', { outcome: 'accepted' });
    const handedOff = at(events, 'human.state', { state: 'handed_off' });
    const completed = at(events, 'human.completed', { outcome: 'handed_off' });
    const segment = at(events, 'route.segment', { role: 'human', kind: 'external' });
    expect(
      requested < delivered &&
        delivered < accepted &&
        accepted < handedOff &&
        handedOff < completed,
    ).toBe(true);
    expect(segment).toBeGreaterThan(completed - 1);
    at(events, 'segment.ended', {
      role: 'human',
      ended: 'carrier_transfer',
      endReason: 'transferred',
    });
    at(events, 'call.outcome', { outcome: 'transferred' });
    expect(result.summary.outcome).toBe('transferred');
    expect(result.summary.human).toMatchObject({
      kind: 'external',
      queueKey: 'desk',
      outcome: 'handed_off',
      requested: 1,
    });
    // The leg was moved, never hung up: one update, a Dial, no status change.
    expect(result.carrierRequests).toHaveLength(1);
    expect(result.carrierRequests[0]!.body).not.toContain('Status');
    expect(
      of(events, 'human.webhook').every((event) => !JSON.stringify(event).includes(ACD_NUMBER)),
    ).toBe(true);
  });

  it('2. async: queued, then a signed destination callback moves the leg to the SIP URI with context headers', async () => {
    env.acd.reply({ status: 200, json: { result: 'queued', ref: 'ACD-77' } });
    const before = env.acd.requests.length;
    let ticket = '';
    const result = await transferCall(
      env,
      async (call) => {
        await heard(env, call, LINES.greeting);
        env.stt.say('I have a strange question');
        await said(env, call, HUMAN_LINES.announcement);
        await deliveries(env, before ? env.acd.deliveries().length : 1);
        ticket = ticketOf(env, env.acd.deliveries().length - 1);
        // A hold line is rendered once, in scenario 1; the speech cache serves it from here on.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        // Nothing moves the leg while the third party is only queueing the caller.
        expect(env.twilioRest.requests.filter((r) => r.url.includes(call.callSid))).toEqual([]);
        const callback = signedCallback(ACD_SECRET, {
          eventId: 'evt-destination-1',
          event: 'destination',
          ticketRef: 'ACD-77',
          destination: {
            sipUri: 'sips:desk@sip.acd.example.com',
            headers: { 'X-Acd-Ticket': 'T-77', 'X-Evil': 'drop-me' },
          },
        });
        const response = await postCallback(env, ticket, callback);
        expect(response.statusCode, response.body).toBeLessThan(300);
        const update = await carrierUpdate(env, call);
        const twiml = twimlOf(update);
        expect(twiml).toContain('<Sip>sips:desk@sip.acd.example.com');
        expect(twiml).toContain('X-OVO-Ticket=' + ticket);
        expect(twiml).toContain('X-OVO-Context-Url=');
        expect(twiml).toContain('X-Acd-Ticket=T-77');
        expect(twiml).not.toContain('X-Evil');
      },
      { carrier: 'handoff' },
    );
    at(result.events, 'call.outcome', { outcome: 'transferred' });
    // Replays and later events: the same event id is a no-op, others append to the finished call.
    const replay = await postCallback(
      env,
      ticket,
      signedCallback(ACD_SECRET, {
        eventId: 'evt-destination-1',
        event: 'destination',
        destination: { e164: ACD_NUMBER },
      }),
    );
    expect(replay.statusCode).toBeLessThan(300);
    for (const [eventId, event, extra] of [
      ['evt-accepted-1', 'accepted', {}],
      ['evt-outcome-1', 'outcome', { outcome: 'answered' }],
      ['evt-released-1', 'released', { reason: 'agent_hangup' }],
    ] as const) {
      const response = await postCallback(
        env,
        ticket,
        signedCallback(ACD_SECRET, { eventId, event, ...extra }),
      );
      expect(response.statusCode, `${event}: ${response.body}`).toBeLessThan(300);
    }
    const folded = await outcomeOf(env, result.jobId);
    expect(folded.summary.human.callbacks).toEqual({
      accepted: true,
      released: true,
      outcome: 'answered',
    });
    // Refusals: a forged signature, an old timestamp, an unknown ticket, a ticket past its window.
    const body = { eventId: 'evt-late-1', event: 'accepted' } as const;
    expect(
      (
        await postCallback(
          env,
          ticket,
          signedCallback(ACD_SECRET, body, { signWith: 'not-the-secret' }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await postCallback(
          env,
          ticket,
          signedCallback(ACD_SECRET, body, { at: Date.now() - 3_600_000 }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await postCallback(
          env,
          '6f1b7d22-0000-4000-8000-000000000000',
          signedCallback(ACD_SECRET, body),
        )
      ).statusCode,
    ).toBe(404);
    await env.stack.db.query(
      "UPDATE ovo_hq_tickets SET callback_until = now() - interval '1 minute' WHERE id = $1",
      [ticket],
    );
    expect(
      (
        await postCallback(
          env,
          ticket,
          signedCallback(ACD_SECRET, { ...body, eventId: 'evt-late-2' }),
        )
      ).statusCode,
    ).toBe(410);
  });
});

function agentNumber(stack: HumanStack): string {
  return stack.agent.number;
}
