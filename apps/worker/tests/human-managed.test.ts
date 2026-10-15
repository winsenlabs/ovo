import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  externalQueue,
  FakeHumanService,
  humanHarness,
  managedQueue,
  assertEventsValid,
} from './human-fixtures.ts';
import {
  connect,
  events,
  handOver,
  harness,
  request,
  type Harness,
} from './human-managed-fixture.ts';
import { signal } from './transfer-fixtures.ts';

afterEach(assertEventsValid);

describe('a managed queue is refused before anything is announced (human queue design 7.2)', () => {
  const refused = async (h: Harness, queueId = 'desk') => {
    await h.started();
    return h.controller.begin(request(queueId), signal());
  };

  it('answers no_operators when nobody eligible is online with room', async () => {
    const h = harness();
    h.service.available = { online: 1, withRoom: 0 };
    expect(await refused(h)).toEqual({ ok: false, reason: 'no_operators' });
    expect(h.service.created).toHaveLength(0);
    expect(events(h, 'human.requested')).toEqual([
      expect.objectContaining({
        queue: 'desk',
        result: 'refused',
        refusal: 'no_operators',
        kind: 'managed',
      }),
    ]);
  });

  it('does not ask for operators when the queue does not require them online', async () => {
    const h = harness({ queues: [managedQueue({ requireOnline: false })] });
    h.service.available = { online: 0, withRoom: 0 };
    expect(await refused(h)).toMatchObject({ ok: true });
  });

  it('answers queue_unavailable when the room provider is missing, down or its breaker is open', async () => {
    expect(await refused(harness({ noRooms: true }))).toEqual({
      ok: false,
      reason: 'queue_unavailable',
    });
    const down = harness();
    down.rooms.healthy = false;
    expect(await refused(down)).toEqual({ ok: false, reason: 'queue_unavailable' });
    const broken = harness();
    for (let i = 0; i < 5; i += 1) broken.shared.breaker(managedQueue().id).failure();
    expect(await refused(broken)).toEqual({ ok: false, reason: 'queue_unavailable' });
  });

  it('answers queue_closed outside its hours and queue_unknown for an unbound key', async () => {
    const closed = harness({
      queues: [managedQueue({ hours: { timezone: 'UTC', weekly: {}, closed: [] } })],
    });
    expect(await refused(closed)).toEqual({ ok: false, reason: 'queue_closed' });
    expect(await refused(harness(), 'nobody')).toEqual({ ok: false, reason: 'queue_unknown' });
    expect(events(harness(), 'human.requested')).toEqual([]);
  });

  it('answers queue_full at maxWaiting and fails closed when storage is down', async () => {
    const full = harness({ queues: [managedQueue({ limits: { maxWaiting: 2 } })] });
    full.service.waiting = 2;
    expect(await refused(full)).toEqual({ ok: false, reason: 'queue_full' });
    const down = harness();
    down.service.operators.availability = async () => {
      throw new Error('storage down');
    };
    expect(await refused(down)).toEqual({ ok: false, reason: 'queue_unavailable' });
  });

  it('creates no ticket at begin, and abandoning before commit undoes nothing', async () => {
    const h = harness();
    await h.started();
    const begun = await h.controller.begin(request(), signal());
    if (!begun.ok) throw new Error(begun.reason);
    expect(h.service.created).toHaveLength(0);
    await h.controller.abandon(begun.handoffId);
    expect(h.service.created).toHaveLength(0);
    expect(h.rooms.seats).toHaveLength(0);
  });
});

describe('a managed queue: ticket, operator, room', () => {
  it('holds the caller until an operator accepts and joins, then connects both ways', async () => {
    const h = harness();
    await handOver(h);
    await h.clock.advance(200);
    expect(h.service.created[0]).toMatchObject({
      idempotencyKey: 'hq:ws-1:job-1:1',
      queue: { key: 'desk', kind: 'managed', mode: 'OPEN_PICKUP' },
      callerMasked: '+91******1234',
      context: { caller: { number: '+919800001234' }, variables: { account_id: 'A-1' } },
    });
    expect(h.holds[0]!.log).toEqual(['start:point']);
    await h.service.accept(h.service.id(1), 'ana');
    await h.clock.advance(200);
    expect(h.rooms.seat()).toMatchObject({ room: `ovo-hq-${h.service.id(1)}`, identity: 'caller' });
    expect(h.controller.attached).toBeUndefined();
    h.rooms.seat().join('op:ana');
    await h.clock.advance(200);
    await vi.waitFor(() => expect(h.controller.attached?.role).toBe('human'));
    // The hold ends the moment the operator is in: no music reaches them.
    expect(h.holds[0]!.log).toEqual(['start:point', 'stop:operator_joined']);
    expect(events(h, 'route.segment')[0]).toMatchObject({
      role: 'human',
      agentId: 'queue:desk',
      ticketId: h.service.id(1),
      kind: 'managed',
    });
    expect(h.controller.attached).toMatchObject({ ticketId: h.service.id(1), operatorId: 'ana' });
    await vi.waitFor(async () =>
      expect((await h.service.ticket(h.service.id(1))).connectedAt).toBeDefined(),
    );

    // Caller to room: whole 20 ms frames, whatever the carrier's chunking.
    h.link.audio(new Uint8Array(400).fill(5));
    h.link.audio(new Uint8Array(100).fill(6));
    expect(h.rooms.seat().sent.map((frame) => frame.length)).toEqual([160, 160, 160]);
    // Operator to caller.
    h.rooms.seat().operatorAudio(new Uint8Array(160).fill(9));
    await vi.waitFor(() => expect(h.link.frames).toHaveLength(1));
    expect([...h.link.frames[0]!.subarray(0, 3)]).toEqual([9, 9, 9]);
    // Keypresses go to the operator only.
    h.link.dtmf('5');
    expect(h.rooms.seat().data).toContainEqual({
      topic: 'ovo.dtmf',
      payload: '{"digit":"5"}',
      identities: ['op:ana'],
    });
  });

  it('beats for the worker every five seconds while the caller waits', async () => {
    const h = harness();
    await handOver(h);
    await h.clock.advance(11_000);
    expect(h.service.beats.length).toBeGreaterThanOrEqual(2);
    expect(new Set(h.service.beats)).toEqual(new Set([h.service.id(1)]));
  });

  it('sees an operator who was in the room before the seat joined', async () => {
    const h = harness();
    await handOver(h);
    await h.clock.advance(200);
    h.rooms.present.set(`ovo-hq-${h.service.id(1)}`, 'op:ana');
    await h.service.accept(h.service.id(1), 'ana');
    await h.clock.advance(400);
    await vi.waitFor(() => expect(h.controller.attached?.role).toBe('human'));
  });

  it('puts an operator who never joins back in the queue, and the caller keeps holding', async () => {
    const h = harness();
    await handOver(h);
    await h.clock.advance(200);
    await h.service.accept(h.service.id(1), 'ana');
    await h.clock.advance(26_000);
    expect(h.rooms.seat().closed).toBe(true);
    const waiting = await h.service.ticket(h.service.id(1));
    expect(waiting.status).toBe('waiting');
    expect(waiting.assignedOperatorId).toBeUndefined();
    expect(
      events(h, 'human.state').some((e) => e.state === 'waiting' && e.code === 'operator_no_show'),
    ).toBe(true);
    expect(h.controller.attached).toBeUndefined();
    // The next operator is connected as usual.
    await h.service.accept(h.service.id(1), 'bo');
    await h.clock.advance(200);
    h.rooms.seat().join('op:bo');
    await h.clock.advance(400);
    await vi.waitFor(() =>
      expect(h.controller.attached).toMatchObject({ role: 'human', operatorId: 'bo' }),
    );
  });

  it('retries a failed seat join, then re-offers the ticket and counts a failure', async () => {
    const h = harness();
    h.rooms.joinFailures = 2;
    await handOver(h);
    await h.clock.advance(200);
    await h.service.accept(h.service.id(1), 'ana');
    await h.clock.advance(400);
    expect((await h.service.ticket(h.service.id(1))).status).toBe('waiting');
    expect(h.audits.filter(([type]) => type === 'human.room.failed')).toHaveLength(2);
  });

  it('runs the hold chain when nobody accepts in time, and releases the ticket', async () => {
    const h = harness();
    await handOver(h);
    await h.clock.advance(61_000);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.service.releases).toEqual([{ id: h.service.id(1), code: 'timed_out' }]);
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'timeout', kind: 'managed' });
    expect(h.rooms.seats).toHaveLength(0);
  });

  it('fails the step when the sweeper expires the ticket under the hold', async () => {
    const h = harness();
    await handOver(h);
    await h.clock.advance(200);
    await h.service.end(h.service.id(1), 'expired');
    await h.clock.advance(300);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'timeout' });
  });

  it('a caller who hangs up while waiting never gets a room', async () => {
    const h = harness();
    await handOver(h);
    await h.clock.advance(200);
    h.link.hangup('caller_hangup');
    await h.controller.close('caller_hangup');
    expect(h.service.releases).toEqual([{ id: h.service.id(1), code: 'call_ended' }]);
    expect(h.rooms.seats).toHaveLength(0);
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'caller_hangup' });
  });

  it('a second ticket on the same call is a new idempotent key', async () => {
    const h = harness();
    await connect(h);
    expect(h.runtime().nextTicket()).toBe(2);
  });
});
