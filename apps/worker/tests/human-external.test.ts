import { verifyWebhookSignature } from '@winsendotai/ovo-session-host';
import { describe, expect, it, vi } from 'vitest';
import { externalQueue, humanHarness, type HumanHarnessOptions } from './human-fixtures.ts';
import { flush, holdPolicy, signal, transferPolicy } from './transfer-fixtures.ts';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

interface Seen {
  headers: Headers;
  body: string;
  json: Record<string, unknown>;
}

/** A fake third-party ACD: answers each request in turn with `answers` (the last repeats). */
function acd(...answers: (Response | (() => Response | Promise<Response>))[]) {
  const seen: Seen[] = [];
  let next = 0;
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    seen.push({
      headers: new Headers(init?.headers),
      body,
      json: JSON.parse(body) as Record<string, unknown>,
    });
    const answer = answers[Math.min(next, answers.length - 1)]!;
    next += 1;
    return typeof answer === 'function' ? answer() : answer.clone();
  });
  return { seen, fetch: fetch as unknown as typeof globalThis.fetch, mock: fetch };
}

const onTimeout = [
  { kind: 'default' as const },
  { kind: 'end' as const, line: { en: 'Goodbye.' } },
];

function harness(fetch: typeof globalThis.fetch, extra: HumanHarnessOptions = {}) {
  return humanHarness({
    policy: transferPolicy({ hold: holdPolicy({ maxSeconds: 30, onTimeout }) }),
    network: { lookup: publicLookup, fetch },
    carrierHandoff: async () => ({ kind: 'confirmed' }),
    ...extra,
  });
}

type Harness = ReturnType<typeof harness>;

/** The router asks for the queue, announces, and ends into the handoff. */
async function handOver(h: Harness, key = 'support-desk') {
  const router = await h.started();
  const begun = await h.controller.begin(
    {
      kind: 'human',
      reason: 'route',
      queueId: key,
      variables: { ovo_route_intent: 'billing' },
    },
    signal(),
  );
  if (!begun.ok) throw new Error(begun.reason);
  h.controller.commit(begun.handoffId);
  await router.complete();
  return begun;
}

const events = (h: Harness, type: string) =>
  h.recorded.filter(([name]) => name === type).map(([, payload]) => payload);

describe('an external queue: the synchronous answer (human queue design 7.4)', () => {
  it('posts one signed, minimal webhook, then hands the leg to the answered number', async () => {
    const handoff = vi.fn(async () => ({ kind: 'confirmed' as const }));
    const third = acd(json({ status: 'accepted', destination: { e164: '+914012345678' } }));
    const h = harness(third.fetch, { carrierHandoff: handoff });
    h.memory.observe('route.decision', {
      path: ['intent'],
      language: 'hi',
      context: { intent: 'billing' },
    });
    await handOver(h);
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.link.closed).toEqual(['transferred']));

    expect(third.seen).toHaveLength(1);
    const [request] = third.seen;
    expect(request!.headers.get('idempotency-key')).toBe('hq:ws-1:job-1:1');
    expect(
      verifyWebhookSignature({
        secret: 'acd-secret',
        timestamp: request!.headers.get('x-ovo-timestamp') ?? undefined,
        id: request!.headers.get('x-ovo-request-id') ?? undefined,
        body: request!.body,
        signature: request!.headers.get('x-ovo-signature') ?? undefined,
        now: h.clock.now(),
      }),
    ).toBe('ok');
    // The default external policy sends no caller number and no transcript.
    expect(request!.body).not.toContain('9800001234');
    expect(request!.json).toMatchObject({
      schema: 'ovo.human-queue/1',
      event: 'handoff',
      ticket: { callbackUrl: expect.stringContaining('/api/v1/human-queue/callbacks/ticket-1') },
      queue: { key: 'support-desk' },
      route: { language: 'hi', intent: 'billing' },
    });
    expect(request!.json).not.toHaveProperty('caller');
    expect(handoff).toHaveBeenCalledWith({ kind: 'phone', e164: '+914012345678' }, 'ticket-1');
    expect(h.service.releases).toEqual([{ id: 'ticket-1', code: 'handed_off' }]);
    expect(h.service.handedOff).toEqual(['ticket-1']);
    expect(h.service.created[0]).toMatchObject({
      idempotencyKey: 'hq:ws-1:job-1:1',
      queue: { key: 'support-desk', kind: 'external' },
      routerAgentId: 'front',
      credentialId: 'acd-hmac',
    });
  });

  it('records the ids, codes and timings of the handoff, never the call', async () => {
    const third = acd(json({ status: 'accepted', destination: { e164: '+914012345678' } }));
    const h = harness(third.fetch);
    await handOver(h);
    await vi.waitFor(() => expect(events(h, 'human.completed')).toHaveLength(1));
    expect(events(h, 'human.requested')).toEqual([
      expect.objectContaining({
        queue: 'support-desk',
        kind: 'external',
        result: 'accepted',
        ticket: 'ticket-1',
      }),
    ]);
    expect(events(h, 'human.webhook').map((e) => e.outcome)).toEqual(['delivered', 'accepted']);
    expect(events(h, 'human.state').map((e) => e.state)).toEqual([
      'waiting',
      'handed_off',
      'released',
    ]);
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'handed_off', segment: 1 });
    expect(events(h, 'route.segment')[0]).toMatchObject({
      role: 'human',
      queueId: expect.any(String),
      ticketId: 'ticket-1',
      kind: 'external',
    });
    const flat = JSON.stringify(h.recorded);
    for (const secret of ['9800001234', '914012345678', 'acd-secret', 'ctx-token'])
      expect(flat).not.toContain(secret);
    await h.controller.close('transferred');
    expect(events(h, 'segment.ended').at(-1)).toMatchObject({
      role: 'human',
      ended: 'carrier_transfer',
      ticketId: 'ticket-1',
    });
  });

  it('the caller stays on the line when the carrier refuses, and the chain goes on', async () => {
    const third = acd(json({ status: 'accepted', destination: { e164: '+914012345678' } }));
    const h = harness(third.fetch, {
      carrierHandoff: async () => ({ kind: 'rejected', reason: 'refer_not_enabled' }),
    });
    await handOver(h);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.link.closed).toEqual([]);
    expect(h.audits).toContainEqual([
      'route.handoff.failed',
      expect.objectContaining({
        reason: 'start_failed',
        detail: 'carrier_refused:refer_not_enabled',
      }),
    ]);
    expect(events(h, 'segment.ended').map((e) => e.ended)).toContain('start_failed');
    expect(h.service.releases).toEqual([{ id: 'ticket-1', code: 'abandoned' }]);
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'failed' });
    // The release default answered in its place.
    expect(h.targets.at(-1)?.target.releaseId).toBe('release-default');
  });

  it('never dials a destination outside the queue policy', async () => {
    const handoff = vi.fn(async () => ({ kind: 'confirmed' as const }));
    const third = acd(json({ status: 'accepted', destination: { e164: '+449999999999' } }));
    const h = harness(third.fetch, { carrierHandoff: handoff });
    await handOver(h);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(handoff).not.toHaveBeenCalled();
    expect(events(h, 'human.webhook').map((e) => e.reason)).toContain(
      'destination_refused:e164_prefix',
    );
    expect(h.service.releases[0]).toEqual({ id: 'ticket-1', code: 'webhook_rejected' });
  });
});

describe('an external queue: queued, then a signed callback', () => {
  it('waits for the destination, then hands on to a SIP URI with the context headers', async () => {
    const handoff = vi.fn(async () => ({ kind: 'confirmed' as const }));
    const third = acd(json({ status: 'queued', ticketRef: 'acd-9' }));
    const h = harness(third.fetch, { carrierHandoff: handoff });
    await handOver(h);
    await vi.waitFor(() =>
      expect(events(h, 'human.webhook').map((e) => e.outcome)).toContain('queued'),
    );
    await h.clock.advance(5_000);
    expect(handoff).not.toHaveBeenCalled();
    h.service.destination('ticket-1', {
      sipUri: 'sips:agent7@pool.acd.example.com',
      headers: { 'X-Acd-Ticket': '123', 'X-Evil': 'nope' },
    });
    await h.clock.advance(500);
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    const [target] = handoff.mock.calls[0] as unknown as [
      { kind: string; uri: string; headers: Record<string, string> },
    ];
    expect(target).toMatchObject({ kind: 'sip', uri: 'sips:agent7@pool.acd.example.com' });
    expect(target.headers).toMatchObject({
      'X-OVO-Call-Id': 'call-1',
      'X-OVO-Ticket': 'ticket-1',
      'X-Acd-Ticket': '123',
      'X-OVO-Context-Url': expect.stringContaining(
        '/api/v1/human-queue/context/ticket-1?t=ctx-token',
      ),
    });
    expect(target.headers).not.toHaveProperty('X-Evil');
    expect(events(h, 'human.state').map((e) => e.state)).toContain('destination');
  });

  it('gives up at the hold limit: tells the third party, releases the ticket, runs the chain', async () => {
    const third = acd(json({ status: 'queued' }));
    const h = harness(third.fetch);
    await handOver(h);
    await vi.waitFor(() =>
      expect(events(h, 'human.webhook').map((e) => e.outcome)).toContain('queued'),
    );
    await h.clock.advance(31_000);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(third.seen.map((seen) => seen.json.event)).toEqual(['handoff', 'cancelled']);
    expect(third.seen[1]!.headers.get('idempotency-key')).toBe('hq:ws-1:job-1:1');
    expect(h.service.releases).toEqual([{ id: 'ticket-1', code: 'timed_out' }]);
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'timeout' });
    expect(events(h, 'human.webhook').map((e) => e.outcome)).toContain('cancelled_sent');
  });

  it('a caller who hangs up while queued is released and the third party told', async () => {
    const third = acd(json({ status: 'queued' }));
    const h = harness(third.fetch);
    await handOver(h);
    await vi.waitFor(() =>
      expect(events(h, 'human.webhook').map((e) => e.outcome)).toContain('queued'),
    );
    h.link.hangup('caller_hangup');
    await h.controller.close('caller_hangup');
    await vi.waitFor(() =>
      expect(h.service.releases).toEqual([{ id: 'ticket-1', code: 'call_ended' }]),
    );
    expect(third.seen.map((seen) => seen.json.event)).toEqual(['handoff', 'cancelled']);
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'caller_hangup' });
  });
});

describe('an external queue: the webhook fails', () => {
  it('retries a 503 with backoff and the same idempotency key, then fails the step', async () => {
    const third = acd(json({}, { status: 503 }));
    const h = harness(third.fetch);
    await handOver(h);
    // 500 ms, then 1 s: base * 2^(n-1), the jitter at its midpoint. The wait begins as the
    // attempt is reported, so each is awaited before the clock moves.
    await vi.waitFor(() => expect(events(h, 'human.webhook')).toHaveLength(1));
    await h.clock.advance(500);
    await vi.waitFor(() => expect(events(h, 'human.webhook')).toHaveLength(2));
    await h.clock.advance(1_000);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(third.seen).toHaveLength(3);
    expect(new Set(third.seen.map((seen) => seen.headers.get('idempotency-key')))).toEqual(
      new Set(['hq:ws-1:job-1:1']),
    );
    expect(events(h, 'human.webhook').map((e) => [e.attempt, e.outcome])).toEqual([
      [1, 'retry'],
      [2, 'retry'],
      [3, 'failed'],
    ]);
    expect(h.service.releases[0]).toEqual({ id: 'ticket-1', code: 'webhook_failed' });
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'unavailable' });
  });

  it('a rejection fails the step at once', async () => {
    const third = acd(json({ status: 'rejected', reason: 'closed' }));
    const h = harness(third.fetch);
    await handOver(h);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(third.seen).toHaveLength(1);
    expect(h.service.releases[0]).toEqual({ id: 'ticket-1', code: 'webhook_rejected' });
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'rejected' });
  });

  it('a credential the router agent may not use fails the step without sending', async () => {
    const third = acd(json({ status: 'accepted' }));
    const h = harness(third.fetch, {
      queues: [
        externalQueue({
          webhook: { ...externalQueue().definition, ...{} },
        }),
      ],
      secrets: {},
    });
    // The fixture resolves any `acd-` credential; one that does not start so is refused.
    const queue = externalQueue();
    (queue.definition as { webhook: { credentialId: string } }).webhook.credentialId = 'other';
    const denied = humanHarness({
      queues: [queue],
      network: { lookup: publicLookup, fetch: third.fetch },
      policy: transferPolicy({ hold: holdPolicy({ maxSeconds: 30, onTimeout }) }),
    });
    await handOver(denied);
    await vi.waitFor(() => expect(denied.journal.entries).toContain('s2.start'));
    expect(third.seen).toHaveLength(0);
    expect(denied.audits).toContainEqual([
      'human.webhook.failed',
      expect.objectContaining({ reason: 'credential_unavailable' }),
    ]);
    await flush();
    expect(h.service.created).toHaveLength(0);
  });
});
