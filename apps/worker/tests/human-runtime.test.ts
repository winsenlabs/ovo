import { vi, afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';
import { HumanShared } from '../src/human-breaker.ts';
import { DEFAULT_QUEUE_HOLD_POLICY, type SegmentHandoffRequest } from '@winsendotai/ovo-contracts';
import { externalQueue, humanHarness, managedQueue, assertEventsValid } from './human-fixtures.ts';
import { holdPolicy, signal, transferPolicy } from './transfer-fixtures.ts';

const request = (queueId: string, key?: string): SegmentHandoffRequest => ({
  kind: 'human',
  reason: key ? 'transfer' : 'route',
  queueId,
  variables: {},
  ...(key ? { transfer: { source: 'llm' as const, key } } : {}),
});

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];

afterEach(assertEventsValid);

describe('the wait of a queue (human queue design 4.4, 16.6)', () => {
  const pointHold = holdPolicy({ maxSeconds: 77 });
  const targetHold = holdPolicy({ maxSeconds: 66 });
  const queueHold = holdPolicy({ maxSeconds: 55 });
  const target = {
    key: 'person',
    description: 'A person',
    destination: { kind: 'node', node: 'start' },
    hold: targetHold,
  } as never;

  /** The hold a begun human handoff would wait with. */
  async function holdOf(queue: ReturnType<typeof managedQueue>, point: boolean, key?: string) {
    const h = humanHarness({
      queues: [queue],
      ...(point ? { policy: transferPolicy({ hold: pointHold, targets: [target] }) } : {}),
    });
    await h.started();
    const begun = await h.controller.begin(request('desk', key), signal());
    if (!begun.ok) throw new Error(begun.reason);
    return (h.controller as unknown as { run: { hold: unknown } }).run.hold;
  }

  it('prefers the queue, then the catalogue target, then the point, then the built-in default', async () => {
    expect(await holdOf(managedQueue({ hold: queueHold }), true, 'person')).toEqual({
      policy: queueHold,
      source: 'queue',
    });
    expect(await holdOf(managedQueue(), true, 'person')).toEqual({
      policy: targetHold,
      source: 'target',
    });
    expect(await holdOf(managedQueue(), true)).toEqual({ policy: pointHold, source: 'point' });
    expect(await holdOf(managedQueue(), false)).toEqual({
      policy: DEFAULT_QUEUE_HOLD_POLICY,
      source: 'default',
    });
  });

  it('is 180 seconds, then return, default and the end line, by default', () => {
    expect(DEFAULT_QUEUE_HOLD_POLICY.maxSeconds).toBe(180);
    expect(DEFAULT_QUEUE_HOLD_POLICY.onTimeout.map((step) => step.kind)).toEqual([
      'return',
      'default',
      'end',
    ]);
  });
});

describe('the prechecks of an external queue', () => {
  const ask = async (h: ReturnType<typeof humanHarness>, queueId = 'support-desk') => {
    await h.started();
    return h.controller.begin(request(queueId), signal());
  };

  it('refuses queue_unavailable when the webhook is off, and when the breaker is open', async () => {
    expect(await ask(humanHarness({ webhookEnabled: false }))).toEqual({
      ok: false,
      reason: 'queue_unavailable',
    });
    const broken = humanHarness();
    for (let i = 0; i < 5; i += 1) broken.shared.breaker(externalQueue().id).failure();
    expect(await ask(broken)).toEqual({ ok: false, reason: 'queue_unavailable' });
    expect(await ask(humanHarness())).toMatchObject({ ok: true });
  });

  it('refuses queue_unavailable without an origin for the callback links', async () => {
    const h = humanHarness();
    (h.runtime().deps as { callbackBaseUrl: string }).callbackBaseUrl = '';
    expect(await ask(h)).toEqual({ ok: false, reason: 'queue_unavailable' });
  });

  it('refuses queue_closed outside its hours, queue_unknown for a key it does not bind', async () => {
    const closed = humanHarness({
      queues: [externalQueue({ hours: { timezone: 'Asia/Kolkata', weekly: {}, closed: [] } })],
    });
    expect(await ask(closed)).toEqual({ ok: false, reason: 'queue_closed' });
    expect(await ask(humanHarness(), 'elsewhere')).toEqual({ ok: false, reason: 'queue_unknown' });
  });

  it('is open at the local wall clock of its zone', async () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const open = humanHarness({
      queues: [
        externalQueue({
          hours: {
            timezone: 'UTC',
            weekly: Object.fromEntries(
              days.map((day) => [day, [{ start: '00:00', end: '23:59' }]]),
            ),
            closed: [],
          },
        }),
      ],
    });
    expect(await ask(open)).toMatchObject({ ok: true });
  });

  it('opens the breaker after five failed deliveries across calls, then refuses the next', async () => {
    const shared = new HumanShared();
    const fetch = vi.fn(
      async () => new Response('{}', { status: 400 }),
    ) as unknown as typeof globalThis.fetch;
    for (let call = 0; call < 5; call += 1) {
      const h = humanHarness({
        shared,
        network: { lookup: publicLookup, fetch },
        policy: transferPolicy({ hold: holdPolicy({ maxSeconds: 20 }) }),
      });
      const router = await h.started();
      const begun = await h.controller.begin(request('support-desk'), signal());
      if (!begun.ok) throw new Error(begun.reason);
      h.controller.commit(begun.handoffId);
      await router.complete();
      await vi.waitFor(() => expect(h.service.releases).toHaveLength(1));
    }
    expect(shared.breaker(externalQueue().id).open).toBe(true);
    expect(await ask(humanHarness({ shared }))).toEqual({ ok: false, reason: 'queue_unavailable' });
  });
});

describe('a queue that fills up', () => {
  it('fails the chain with queue_full when the ticket cannot be created for room', async () => {
    const h = humanHarness({
      queues: [managedQueue()],
      policy: transferPolicy({
        hold: holdPolicy({ maxSeconds: 20, onTimeout: [{ kind: 'default' }] }),
      }),
    });
    h.service.createAnswer = 'queue_full';
    const router = await h.started();
    const begun = await h.controller.begin(request('desk'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await router.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.audits.find(([type]) => type === 'route.handoff.chain')?.[1]).toMatchObject({
      reason: 'queue_full',
    });
  });

  it('fails closed when the ticket store is down: no ticket, the chain moves on', async () => {
    const h = humanHarness({
      queues: [managedQueue()],
      policy: transferPolicy({
        hold: holdPolicy({ maxSeconds: 20, onTimeout: [{ kind: 'default' }] }),
      }),
    });
    h.service.failCreate = true;
    const router = await h.started();
    const begun = await h.controller.begin(request('desk'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await router.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.audits.map(([type]) => type)).toContain('human.ticket.failed');
    expect(h.recorded.map(([type]) => type)).not.toContain('human.requested');
  });
});
