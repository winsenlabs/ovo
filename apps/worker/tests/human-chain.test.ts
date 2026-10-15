import { describe, expect, it, vi } from 'vitest';
import {
  humanHarness,
  managedQueue,
  externalQueue,
  OVERFLOW_ID,
  type HumanHarness,
} from './human-fixtures.ts';
import {
  agentRequest,
  holdPolicy,
  signal,
  transferPolicy,
  transferHarness,
} from './transfer-fixtures.ts';

const transferring = {
  kind: 'human',
  reason: 'transfer',
  queueId: 'desk',
  variables: { ovo_route_intent: 'billing' },
  transfer: { source: 'llm', key: 'person', summary: 'Wants a refund', reason: 'billing' },
} as const;

const events = (h: HumanHarness, type: string) =>
  h.recorded.filter(([name]) => name === type).map(([, payload]) => payload);

/** An agent (claimed from a pool member) asks for `desk`, whose hold runs `onTimeout`. */
async function asking(
  onTimeout: ReturnType<typeof holdPolicy>['onTimeout'],
  queues = [managedQueue()],
  deskHold = 20,
) {
  const h = humanHarness({
    first: 'agent',
    queues,
    policy: transferPolicy({ hold: holdPolicy({ maxSeconds: deskHold, onTimeout }) }),
  });
  const agent = await h.started();
  const begun = await h.controller.begin(transferring, signal());
  if (!begun.ok) throw new Error(begun.reason);
  h.controller.commit(begun.handoffId);
  await agent.complete();
  return h;
}

const overflow = (over: Record<string, unknown> = {}) =>
  managedQueue({ name: 'Overflow desk', ...over }, 'overflow', OVERFLOW_ID);

describe("the hold's human step is a real overflow queue (human queue design 7.6)", () => {
  it('moves to the overflow queue with its own wait, releasing the first ticket', async () => {
    const h = await asking(
      [{ kind: 'human', queueId: 'overflow' }, { kind: 'default' }],
      [managedQueue(), overflow({ hold: holdPolicy({ maxSeconds: 90 }) })],
    );
    await h.clock.advance(21_000);
    expect(h.service.created.map((ticket) => [ticket.idempotencyKey, ticket.queue.key])).toEqual([
      ['hq:ws-1:job-1:1', 'desk'],
      ['hq:ws-1:job-1:2', 'overflow'],
    ]);
    expect(h.service.releases).toEqual([{ id: 'ticket-1', code: 'timed_out' }]);
    // The overflow queue waits its own 90 s, not the 20 s of the first or a chain step's 60 s.
    expect(new Date(h.service.created[1]!.expiresAt).getTime() - h.clock.now()).toBeGreaterThan(
      85_000,
    );
    await h.clock.advance(70_000);
    expect(h.journal.entries).not.toContain('s2.start');
    // Someone on the overflow desk picks up.
    h.service.accept('ticket-2', 'bo');
    await h.clock.advance(300);
    h.rooms.seat().join('op:bo');
    await h.clock.advance(300);
    await vi.waitFor(() =>
      expect(h.controller.attached).toMatchObject({ role: 'human', ticketId: 'ticket-2' }),
    );
    expect(events(h, 'transfer.completed')[0]).toMatchObject({
      outcome: 'fallback',
      steps: [{ step: 'human', result: 'taken' }],
    });
    expect(events(h, 'human.requested').map((e) => e.result)).toEqual(['accepted', 'accepted']);
  });

  it('never revisits a queue: a chain that names it again fails that step with queue_loop', async () => {
    const h = await asking([{ kind: 'human', queueId: 'desk' }, { kind: 'default' }]);
    await h.clock.advance(21_000);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(events(h, 'transfer.completed')[0]).toMatchObject({
      steps: [
        { step: 'human', result: 'failed', reason: 'queue_loop' },
        { step: 'default', result: 'taken' },
      ],
    });
    expect(h.service.created).toHaveLength(1);
  });

  it('records a refused overflow queue with its code and goes on down the chain', async () => {
    const h = await asking(
      [{ kind: 'human', queueId: 'overflow' }, { kind: 'default' }],
      [managedQueue(), overflow({ hours: { timezone: 'UTC', weekly: {}, closed: [] } })],
    );
    await h.clock.advance(21_000);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(events(h, 'transfer.completed')[0]).toMatchObject({
      steps: [
        { step: 'human', result: 'failed', reason: 'queue_closed' },
        { step: 'default', result: 'taken' },
      ],
    });
    expect(events(h, 'human.requested').at(-1)).toMatchObject({
      queue: 'overflow',
      source: 'chain',
      result: 'refused',
      refusal: 'queue_closed',
    });
  });

  it('can start from an external queue and overflow to a managed one', async () => {
    const third = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'queued' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const h = humanHarness({
      first: 'agent',
      queues: [
        externalQueue({
          hold: holdPolicy({
            maxSeconds: 20,
            onTimeout: [{ kind: 'human', queueId: 'overflow' }, { kind: 'default' }],
          }),
        }),
        overflow(),
      ],
      network: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
        fetch: third as unknown as typeof globalThis.fetch,
      },
      policy: transferPolicy({
        hold: holdPolicy({ maxSeconds: 20, onTimeout: [{ kind: 'default' }] }),
      }),
    });
    const agent = await h.started();
    const begun = await h.controller.begin({ ...transferring, queueId: 'support-desk' }, signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await agent.complete();
    await h.clock.advance(21_000);
    // The third party was told, the ticket released, and the overflow ticket is open.
    expect(third.mock.calls.length).toBe(2);
    expect(h.service.created.map((ticket) => ticket.queue.kind)).toEqual(['external', 'managed']);
    expect(h.service.releases[0]).toEqual({ id: 'ticket-1', code: 'timed_out' });
  });
});

describe('without human queues composed, a call is exactly as in R2 (flag-off parity)', () => {
  it('skips a human step with human_queue_unavailable', async () => {
    const h = transferHarness({
      first: 'agent',
      policy: transferPolicy({
        hold: holdPolicy({
          maxSeconds: 20,
          onTimeout: [{ kind: 'human', queueId: 'desk' }, { kind: 'default' }],
        }),
      }),
      compose: { 'release-b': 'fail' },
    });
    const agent = await h.started();
    const begun = await h.controller.begin(agentRequest('release-b'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await agent.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.event('transfer.completed')).toMatchObject({
      steps: [
        { step: 'human', result: 'skipped', reason: 'human_queue_unavailable' },
        { step: 'default', result: 'taken' },
      ],
    });
  });

  it('answers a human handoff human_queue_unavailable, which the router skips', async () => {
    const h = transferHarness({ first: 'router' });
    await h.started();
    expect(await h.controller.begin(transferring, signal())).toEqual({
      ok: false,
      reason: 'human_queue_unavailable',
    });
    expect(h.recorded.filter(([type]) => type.startsWith('human.'))).toEqual([]);
  });
});
