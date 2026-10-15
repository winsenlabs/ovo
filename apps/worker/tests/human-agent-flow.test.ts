import { describe, expect, it, vi } from 'vitest';
import { createAgentTransferPort } from '../src/transfer-port.ts';
import { humanHarness, managedQueue, POOL_FOR_TESTS } from './human-fixtures.ts';
import { holdPolicy, signal, transferPolicy } from './transfer-fixtures.ts';

const person = (over: Record<string, unknown> = {}) =>
  ({
    key: 'person',
    description: 'Hand over to a human colleague',
    destination: { kind: 'human', queueId: 'desk' },
    ...over,
  }) as never;

const wait = holdPolicy({
  maxSeconds: 20,
  onTimeout: [{ kind: 'return' }, { kind: 'end', line: { en: 'Goodbye.' } }],
});

function setup(
  over: {
    target?: Record<string, unknown>;
    queue?: Record<string, unknown>;
    pointAnnouncement?: boolean;
  } = {},
) {
  const policy = transferPolicy({
    targets: [person(over.target)],
    hold: wait,
    ...(over.pointAnnouncement ? { announcement: { en: 'The point says hold on.' } } : {}),
  });
  const queue = managedQueue({
    announcement: { en: 'A colleague is joining. Please hold.' },
    ...over.queue,
  });
  const h = humanHarness({ first: 'agent', queues: [queue], policy });
  const port = createAgentTransferPort({
    controller: h.controller,
    self: {
      index: 0,
      agentId: 'agent-a',
      releaseId: 'release-a',
      poolId: POOL_FOR_TESTS,
      memberId: 'member-a',
    },
    release: { config: { language: 'en', variables: {}, handoff: {} } as never },
    policy,
    targets: {
      snapshot: { pools: {}, language: { default: 'en', allowed: ['en'] } },
      memory: h.memory,
      claims: h.claims,
      now: () => h.clock.now(),
    },
    humanQueue: (key) => (key === 'desk' ? queue : undefined),
    record: (type, payload) => h.recorded.push([type, payload]),
    log: (event, fields) => h.logs.push([event, fields]),
  });
  return { h, port };
}

const ask = {
  key: 'person',
  source: 'llm' as const,
  confirmed: false,
  summary: 'Wants a refund',
  reason: 'billing',
};
const events = (h: ReturnType<typeof setup>['h'], type: string) =>
  h.recorded.filter(([name]) => name === type).map(([, payload]) => payload);

describe('an agent transfers to a human target (human queue design 7.6)', () => {
  it('announces with the queue line, holds, and is returned to the agent after the hold times out', async () => {
    const { h, port } = setup();
    const agent = await h.started();
    const result = await port.request(ask, signal());
    expect(result).toMatchObject({
      ok: true,
      queued: false,
      announcement: 'A colleague is joining. Please hold.',
    });
    if (!result.ok) return;
    port.commit(result.transferId);
    await agent.complete();
    await h.clock.advance(300);
    // The transferring agent's own words travel in the ticket, nowhere else.
    expect(h.service.created[0]!.context).toMatchObject({
      summary: 'Wants a refund',
      reason: 'billing',
    });
    expect(JSON.stringify(h.recorded)).not.toContain('Wants a refund');
    expect(events(h, 'transfer.requested')[0]).toMatchObject({
      kind: 'human',
      key: 'person',
      result: 'accepted',
    });
    await h.clock.advance(21_000);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.service.releases).toEqual([{ id: 'ticket-1', code: 'timed_out' }]);
    expect(events(h, 'transfer.completed')[0]).toMatchObject({
      outcome: 'returned',
      steps: [{ step: 'return', result: 'taken' }],
    });
    expect(events(h, 'route.segment').at(-1)).toMatchObject({
      role: 'agent',
      reason: 'return',
      agentId: 'agent-a',
    });
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'timeout' });
  });

  it('announces with the target line first, then the queue line, then the point line', async () => {
    const withTarget = setup({
      target: { announcement: { en: 'Target line.' } },
      pointAnnouncement: true,
    });
    await withTarget.h.started();
    expect(await withTarget.port.request(ask, signal())).toMatchObject({
      announcement: 'Target line.',
    });
    const withQueue = setup({ pointAnnouncement: true });
    await withQueue.h.started();
    expect(await withQueue.port.request(ask, signal())).toMatchObject({
      announcement: 'A colleague is joining. Please hold.',
    });
    const withPoint = setup({ queue: { announcement: undefined }, pointAnnouncement: true });
    await withPoint.h.started();
    expect(await withPoint.port.request(ask, signal())).toMatchObject({
      announcement: 'The point says hold on.',
    });
  });

  it.each([
    ['queue_closed', { hours: { timezone: 'UTC', weekly: {}, closed: [] } }, undefined],
    ['no_operators', {}, { online: 0, withRoom: 0 }],
  ] as const)(
    'is refused %s before anything is announced, and the agent keeps the call',
    async (reason, queue, available) => {
      const { h, port } = setup({ queue });
      if (available) h.service.available = available;
      const agent = await h.started();
      expect(await port.request(ask, signal())).toEqual({ ok: false, reason });
      expect(events(h, 'transfer.requested')[0]).toMatchObject({
        kind: 'human',
        result: 'refused',
        refusal: reason,
      });
      expect(events(h, 'human.requested')[0]).toMatchObject({
        result: 'refused',
        refusal: reason,
        source: 'llm',
      });
      expect(h.service.created).toHaveLength(0);
      expect(h.controller.busy).toBe(false);
      expect(h.holds).toHaveLength(0);
      void agent;
    },
  );

  it('counts the transfer and tags the human segment with it', async () => {
    const { h, port } = setup();
    const agent = await h.started();
    const result = await port.request(ask, signal());
    if (!result.ok) throw new Error(result.reason);
    port.commit(result.transferId);
    await agent.complete();
    await h.clock.advance(200);
    h.service.accept('ticket-1', 'ana');
    await h.clock.advance(200);
    h.rooms.seat().join('op:ana');
    await h.clock.advance(300);
    await vi.waitFor(() => expect(h.controller.attached?.role).toBe('human'));
    expect(h.controller.transfers).toBe(1);
    expect(h.controller.attached).toMatchObject({ transfer: 1, agentId: 'queue:desk' });
    expect(events(h, 'transfer.completed')[0]).toMatchObject({
      outcome: 'connected',
      toSegment: 1,
    });
    expect(events(h, 'route.segment')[0]).toMatchObject({
      role: 'human',
      reason: 'transfer',
      transfer: 1,
      fromIndex: 0,
    });
  });
});

describe('what a human segment frees and logs', () => {
  it("lets go of the capacity the agent's pool member held, as an agent target with no member does", async () => {
    const { h, port } = setup();
    const agent = await h.started();
    const result = await port.request(ask, signal());
    if (!result.ok) throw new Error(result.reason);
    port.commit(result.transferId);
    await agent.complete();
    await h.clock.advance(200);
    expect(h.claims.release).not.toHaveBeenCalled();
    h.service.accept('ticket-1', 'ana');
    await h.clock.advance(200);
    h.rooms.seat().join('op:ana');
    await h.clock.advance(300);
    await vi.waitFor(() => expect(h.controller.attached?.role).toBe('human'));
    expect(h.claims.release).toHaveBeenCalledOnce();
  });

  it('logs ids and codes only: requested, ticket, connected, completed, never the call', async () => {
    const { h, port } = setup();
    const agent = await h.started();
    const result = await port.request(ask, signal());
    if (!result.ok) throw new Error(result.reason);
    port.commit(result.transferId);
    await agent.complete();
    await h.clock.advance(200);
    h.service.accept('ticket-1', 'ana');
    await h.clock.advance(200);
    h.rooms.seat().join('op:ana');
    await h.clock.advance(300);
    h.link.hangup('caller_hangup');
    await h.controller.close('caller_hangup');
    const names = h.logs.map(([event]) => event).filter((event) => event.startsWith('human_'));
    expect(names).toEqual([
      'human_requested',
      'human_ticket',
      'human_connected',
      'human_completed',
      'human_bridge_closed',
    ]);
    const flat = JSON.stringify(h.logs);
    for (const secret of ['9800001234', 'Wants a refund', 'A-1', 'ctx-token'])
      expect(flat).not.toContain(secret);
  });
});
