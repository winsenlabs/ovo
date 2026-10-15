import { afterEach, describe, expect, it } from 'vitest';
import {
  humanQueueApp,
  makeQueue,
  managed,
  onlineOperator,
  openTicket,
  profile,
  WORKSPACE,
  type HqApp,
} from './human-queue-fixtures.ts';

const apps: HqApp[] = [];
const make = (options: Parameters<typeof humanQueueApp>[0] = {}) => {
  const built = humanQueueApp(options);
  apps.push(built);
  return built;
};
afterEach(async () => Promise.all(apps.splice(0).map((hq) => hq.app.close())));

/** Two queues (support, billing), operators for each, and one ticket waiting in support. */
async function floor(hq: HqApp) {
  const support = await makeQueue(
    hq,
    managed({
      name: 'Support',
      teamIds: ['support'],
      returnTargets: ['bot'],
      wrapUp: { required: false, dispositions: ['Resolved', 'Escalated'] },
    }),
  );
  const billing = await makeQueue(hq, managed({ name: 'Billing', teamIds: ['billing'] }));
  await onlineOperator(hq, 'asha', { teamIds: ['support'] });
  await onlineOperator(hq, 'ravi', { teamIds: ['billing'] });
  const ticket = await openTicket(hq, support);
  return { support, billing, ticket };
}

const accept = (hq: HqApp, ticket: { id: string; version: number }, operatorId: string) =>
  hq.service.tickets.accept({
    workspaceId: WORKSPACE,
    ticketId: ticket.id,
    operatorId,
    expectedVersion: ticket.version,
    idempotencyKey: `k-${ticket.id}-${operatorId}`,
  });

describe('who may use the desk', () => {
  it('needs an operator profile, enabled, whatever the role', async () => {
    const hq = make();
    await floor(hq);
    for (const [user, role] of [
      ['nobody', 'admin'],
      ['nobody', 'viewer'],
    ] as const) {
      const response = await hq.call('GET', '/v1/desk/me', { user, role });
      expect([response.statusCode, response.json().error.code]).toEqual([
        403,
        'operator_profile_required',
      ]);
    }
    await hq.service.operators.upsert(profile('off', { enabled: false }));
    expect((await hq.call('GET', '/v1/desk/me', { user: 'off' })).json().error.code).toBe(
      'operator_profile_required',
    );
    expect((await hq.call('GET', '/v1/desk/me', { user: 'asha', role: 'viewer' })).statusCode).toBe(
      200,
    );
  });

  it('is behind sign-in', async () => {
    const hq = make();
    expect(
      (await hq.call('GET', '/v1/desk/me', { headers: { 'x-anonymous': '1' } })).statusCode,
    ).toBe(401);
  });
});

describe('GET /v1/desk/me', () => {
  it('describes the operator, the queues of their teams with readable send-back targets, and the room', async () => {
    const hq = make();
    await floor(hq);
    const response = await hq.call('GET', '/v1/desk/me', { user: 'asha', role: 'viewer' });
    expect(response.headers['cache-control']).toBe('no-store');
    const me = response.json();
    expect(me.profile).toMatchObject({ userId: 'asha', teamIds: ['support'], enabled: true });
    expect(me.status).toBe('AVAILABLE');
    expect(me.queues.map((q: { name: string }) => q.name)).toEqual(['Support']);
    expect(me.queues[0]).toMatchObject({
      assignment: 'OPEN_PICKUP',
      returnTargets: [{ key: 'bot', label: 'Bot' }],
      wrapUp: { required: false, dispositions: ['Resolved', 'Escalated'] },
    });
    expect(me.roomProvider).toEqual({ provider: 'fake-room', serverUrl: 'wss://rooms.fake.test' });
    expect(me.presenceTtlSeconds).toBe(30);
    expect(me.stats).toEqual({ handledToday: 0, activeNow: 0, onlineOperators: 1 });
  });

  it('shows a queue with no teams to every operator, and counts only colleagues who share a team', async () => {
    const hq = make();
    await makeQueue(hq, managed({ name: 'Everyone' }));
    await onlineOperator(hq, 'asha', { teamIds: ['support'] });
    await onlineOperator(hq, 'ravi', { teamIds: ['billing'] });
    const me = (await hq.call('GET', '/v1/desk/me', { user: 'asha' })).json();
    expect(me.queues.map((q: { name: string }) => q.name)).toEqual(['Everyone']);
    expect(me.stats.onlineOperators).toBe(1);
  });

  it('counts the operator’s active calls', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    expect((await hq.call('GET', '/v1/desk/me', { user: 'asha' })).json().stats.activeNow).toBe(1);
  });

  it('labels a send-back target from the routing point that binds the queue', async () => {
    const hq = make({
      points: {
        'point-1': {
          draft: { transfer: { targets: [{ key: 'bot', label: { en: 'Billing assistant' } }] } },
        },
      },
    });
    const { support } = await floor(hq);
    hq.service.bindPoint('point-1', [support.id]);
    const me = (await hq.call('GET', '/v1/desk/me', { user: 'asha' })).json();
    expect(me.queues[0].returnTargets).toEqual([{ key: 'bot', label: 'Billing assistant' }]);
  });

  it('makes an unlabelled target’s key readable', async () => {
    const hq = make();
    await makeQueue(hq, managed({ name: 'Q', returnTargets: ['billing-bot', 'sales_desk'] }));
    await onlineOperator(hq, 'asha');
    const targets = (await hq.call('GET', '/v1/desk/me', { user: 'asha' })).json().queues[0]
      .returnTargets;
    expect(targets.map((t: { label: string }) => t.label)).toEqual(['Billing bot', 'Sales desk']);
  });

  it('reports no room provider when none is composed', async () => {
    const hq = make({ noRooms: true });
    await floor(hq);
    expect((await hq.call('GET', '/v1/desk/me', { user: 'asha' })).json().roomProvider).toEqual({
      provider: '',
      serverUrl: '',
    });
  });
});

describe('presence', () => {
  it('sets and reads back the status, and a heartbeat refreshes it', async () => {
    const hq = make();
    await hq.service.operators.upsert(profile('asha'));
    expect(
      (
        await hq.call('PUT', '/v1/desk/presence', {
          user: 'asha',
          payload: { status: 'AVAILABLE' },
        })
      ).json(),
    ).toEqual({ status: 'AVAILABLE' });
    expect((await hq.call('GET', '/v1/desk/me', { user: 'asha' })).json().status).toBe('AVAILABLE');
    hq.service.clock.advance(25_000);
    expect(
      (await hq.call('POST', '/v1/desk/heartbeat', { user: 'asha', payload: {} })).json(),
    ).toEqual({ status: 'AVAILABLE' });
    hq.service.clock.advance(25_000);
    expect((await hq.call('GET', '/v1/desk/me', { user: 'asha' })).json().status).toBe('AVAILABLE');
    hq.service.clock.advance(35_000);
    expect((await hq.call('GET', '/v1/desk/me', { user: 'asha' })).json().status).toBe('OFFLINE');
    expect(
      (
        await hq.call('PUT', '/v1/desk/presence', { user: 'asha', payload: { status: 'OFFLINE' } })
      ).json(),
    ).toEqual({ status: 'OFFLINE' });
  });

  it('answers 422 for a status it does not know', async () => {
    const hq = make();
    await hq.service.operators.upsert(profile('asha'));
    const response = await hq.call('PUT', '/v1/desk/presence', {
      user: 'asha',
      payload: { status: 'BUSY' },
    });
    expect([response.statusCode, response.json().error.code]).toEqual([422, 'presence_invalid']);
  });
});

describe('the queue list', () => {
  it('shows an operator only the tickets of their teams, with the caller masked', async () => {
    const hq = make();
    const { billing } = await floor(hq);
    await openTicket(hq, billing);
    const asha = (await hq.call('GET', '/v1/desk/tickets?scope=queue', { user: 'asha' })).json()
      .items;
    expect(asha).toHaveLength(1);
    expect(asha[0]).toMatchObject({
      queueName: 'Support',
      status: 'waiting',
      callerMasked: '+91••••00',
    });
    expect(JSON.stringify(asha)).not.toContain('9800000000');
    const ravi = (await hq.call('GET', '/v1/desk/tickets', { user: 'ravi' })).json().items;
    expect(ravi.map((t: { queueName: string }) => t.queueName)).toEqual(['Billing']);
  });

  it('lists an operator’s own calls under scope=mine only', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    expect(
      (await hq.call('GET', '/v1/desk/tickets?scope=queue', { user: 'asha' })).json().items,
    ).toEqual([]);
    expect(
      (await hq.call('GET', '/v1/desk/tickets?scope=mine', { user: 'asha' }))
        .json()
        .items.map((t: { id: string }) => t.id),
    ).toEqual([ticket.id]);
    expect(
      (await hq.call('GET', '/v1/desk/tickets?scope=mine', { user: 'ravi' })).json().items,
    ).toEqual([]);
  });

  it('rejects an unknown scope', async () => {
    const hq = make();
    await floor(hq);
    expect((await hq.call('GET', '/v1/desk/tickets?scope=all', { user: 'asha' })).statusCode).toBe(
      400,
    );
  });
});

describe('declining', () => {
  it('hides the ticket from this operator only', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await onlineOperator(hq, 'meera', { teamIds: ['support'] });
    const response = await hq.call('POST', `/v1/desk/tickets/${ticket.id}/decline`, {
      user: 'asha',
      payload: { expectedVersion: ticket.version },
    });
    expect(response.statusCode).toBe(204);
    expect((await hq.call('GET', '/v1/desk/tickets', { user: 'asha' })).json().items).toEqual([]);
    expect((await hq.call('GET', '/v1/desk/tickets', { user: 'meera' })).json().items).toHaveLength(
      1,
    );
    expect(hq.audits.at(-1)).toMatchObject({ action: 'desk.decline' });
  });

  it('answers 409 for a stale version and 422 for a bad body', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    const stale = await hq.call('POST', `/v1/desk/tickets/${ticket.id}/decline`, {
      user: 'asha',
      payload: { expectedVersion: 9 },
    });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'conflict']);
    expect(
      (
        await hq.call('POST', `/v1/desk/tickets/${ticket.id}/decline`, {
          user: 'asha',
          payload: {},
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe('the call context', () => {
  it('goes to the assigned operator only, never cached', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    const before = await hq.call('GET', `/v1/desk/tickets/${ticket.id}/context`, { user: 'asha' });
    expect([before.statusCode, before.json().error.code]).toEqual([403, 'forbidden']);
    await accept(hq, ticket, 'asha');
    const mine = await hq.call('GET', `/v1/desk/tickets/${ticket.id}/context`, { user: 'asha' });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.json()).toMatchObject({
      summary: 'Caller asks about a charge.',
      caller: { number: '+919800000000' },
    });
    expect(
      (await hq.call('GET', `/v1/desk/tickets/${ticket.id}/context`, { user: 'ravi' })).statusCode,
    ).toBe(403);
  });

  it('is 404 for an unknown ticket and 410 once scrubbed', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    expect(
      (
        await hq.call('GET', '/v1/desk/tickets/00000000-0000-4000-8000-000000000009/context', {
          user: 'asha',
        })
      ).statusCode,
    ).toBe(404);
    await hq.service.tickets.release({
      workspaceId: WORKSPACE,
      ticketId: ticket.id,
      expectedVersion: (await hq.service.tickets.get(ticket.id))!.version,
      reason: 'completed',
      idempotencyKey: 'r',
      code: 'completed',
      by: 'operator',
    });
    hq.service.clock.advance(25 * 3_600_000);
    await hq.service.sweep(hq.service.clock.now());
    const gone = await hq.call('GET', `/v1/desk/tickets/${ticket.id}/context`, { user: 'asha' });
    expect([gone.statusCode, gone.json().error.code]).toEqual([410, 'context_expired']);
  });
});

describe('commands', () => {
  async function accepted(hq: HqApp) {
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    return ticket;
  }
  const command = (hq: HqApp, id: string, payload: unknown, user = 'asha') =>
    hq.call('POST', `/v1/desk/tickets/${id}/commands`, { user, payload });

  it('queues end_call for the worker and returns its sequence number', async () => {
    const hq = make();
    const ticket = await accepted(hq);
    const response = await command(hq, ticket.id, { kind: 'end_call' });
    expect([response.statusCode, response.json()]).toEqual([202, { seq: 1 }]);
    expect((await hq.service.tickets.get(ticket.id))!.command).toMatchObject({
      seq: 1,
      ack: 0,
      body: { kind: 'end_call' },
    });
    expect((await command(hq, ticket.id, { kind: 'end_call' })).json().seq).toBe(2);
    expect(hq.audits.at(-1)).toMatchObject({
      action: 'desk.command',
      payload: { kind: 'end_call', seq: 2 },
    });
  });

  it('accepts return_to_agent only to a target of the queue', async () => {
    const hq = make();
    const ticket = await accepted(hq);
    expect(
      (await command(hq, ticket.id, { kind: 'return_to_agent', target: 'bot' })).statusCode,
    ).toBe(202);
    const refused = await command(hq, ticket.id, { kind: 'return_to_agent', target: 'sales-bot' });
    expect([refused.statusCode, refused.json().error.code]).toEqual([
      422,
      'return_target_not_allowed',
    ]);
  });

  it('refuses another operator, an ended call and a malformed command', async () => {
    const hq = make();
    const ticket = await accepted(hq);
    expect((await command(hq, ticket.id, { kind: 'end_call' }, 'ravi')).statusCode).toBe(403);
    expect((await command(hq, ticket.id, { kind: 'whisper' })).statusCode).toBe(422);
    expect((await command(hq, ticket.id, { kind: 'return_to_agent' })).statusCode).toBe(422);
    expect(
      (await command(hq, '00000000-0000-4000-8000-000000000009', { kind: 'end_call' })).statusCode,
    ).toBe(404);
    await hq.service.tickets.release({
      workspaceId: WORKSPACE,
      ticketId: ticket.id,
      expectedVersion: (await hq.service.tickets.get(ticket.id))!.version,
      reason: 'completed',
      idempotencyKey: 'r',
      code: 'completed',
      by: 'worker',
    });
    const ended = await command(hq, ticket.id, { kind: 'end_call' });
    expect([ended.statusCode, ended.json().error.code]).toEqual([409, 'ticket_not_active']);
  });
});

describe('wrap-up', () => {
  it('stores the wrap-up and records the disposition on the call', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    const response = await hq.call('PUT', `/v1/desk/tickets/${ticket.id}/wrap-up`, {
      user: 'asha',
      payload: { disposition: 'Resolved', note: 'refund issued' },
    });
    expect(response.statusCode, response.body).toBe(204);
    expect((await hq.service.tickets.get(ticket.id))!.wrapUp).toEqual({
      disposition: 'Resolved',
      note: 'refund issued',
    });
    const callId = (await hq.service.tickets.get(ticket.id))!.callId;
    const events = await hq.outcomes.listEvents(WORKSPACE, callId);
    expect(events.items.map((e) => [e.type, e.payload])).toEqual([
      ['disposition', expect.objectContaining({ disposition: 'Resolved', source: 'system' })],
    ]);
    await hq.call('PUT', `/v1/desk/tickets/${ticket.id}/wrap-up`, {
      user: 'asha',
      payload: { disposition: 'Resolved' },
    });
    expect((await hq.outcomes.listEvents(WORKSPACE, callId)).items).toHaveLength(1);
    await hq.call('PUT', `/v1/desk/tickets/${ticket.id}/wrap-up`, {
      user: 'asha',
      payload: { disposition: 'Escalated' },
    });
    expect((await hq.outcomes.listEvents(WORKSPACE, callId)).items).toHaveLength(2);
  });

  it('allows a wrap-up after the call ended, and a note without a disposition', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    await hq.service.tickets.release({
      workspaceId: WORKSPACE,
      ticketId: ticket.id,
      expectedVersion: (await hq.service.tickets.get(ticket.id))!.version,
      reason: 'completed',
      idempotencyKey: 'r',
      code: 'completed',
      by: 'worker',
    });
    const response = await hq.call('PUT', `/v1/desk/tickets/${ticket.id}/wrap-up`, {
      user: 'asha',
      payload: { note: 'called back' },
    });
    expect(response.statusCode).toBe(204);
  });

  it('only takes one of the queue’s dispositions, from the assigned operator, within limits', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    const wrong = await hq.call('PUT', `/v1/desk/tickets/${ticket.id}/wrap-up`, {
      user: 'asha',
      payload: { disposition: 'Lost' },
    });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([422, 'wrap_up_invalid']);
    expect(
      (
        await hq.call('PUT', `/v1/desk/tickets/${ticket.id}/wrap-up`, {
          user: 'ravi',
          payload: { note: 'x' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await hq.call('PUT', `/v1/desk/tickets/${ticket.id}/wrap-up`, {
          user: 'asha',
          payload: { note: 'x'.repeat(1_001) },
        })
      ).statusCode,
    ).toBe(422);
  });

  it('is closed once the call details were scrubbed', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    await hq.service.tickets.release({
      workspaceId: WORKSPACE,
      ticketId: ticket.id,
      expectedVersion: (await hq.service.tickets.get(ticket.id))!.version,
      reason: 'completed',
      idempotencyKey: 'r',
      code: 'completed',
      by: 'worker',
    });
    hq.service.clock.advance(25 * 3_600_000);
    await hq.service.sweep(hq.service.clock.now());
    const response = await hq.call('PUT', `/v1/desk/tickets/${ticket.id}/wrap-up`, {
      user: 'asha',
      payload: { note: 'late' },
    });
    expect([response.statusCode, response.json().error.code]).toEqual([410, 'wrap_up_closed']);
  });
});

describe('re-minting a token and leaving', () => {
  it('re-mints a room-scoped, short-lived, audio-only grant for the assigned operator', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    const response = await hq.call('POST', `/v1/desk/tickets/${ticket.id}/token`, {
      user: 'asha',
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { room } = response.json();
    expect(room).toMatchObject({
      provider: 'fake-room',
      serverUrl: 'wss://rooms.fake.test',
      role: 'operator',
      identity: 'op:asha',
      roomName: `ovo-hq-${ticket.id}`,
    });
    const claims = await hq.rooms!.claimsOf(room.token);
    expect(claims).toMatchObject({
      room: `ovo-hq-${ticket.id}`,
      identity: 'op:asha',
      canJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      roomAdmin: false,
      roomCreate: false,
      roomList: false,
    });
    expect(claims.expiresAtMs - claims.issuedAtMs).toBeLessThanOrEqual(121_000);
  });

  it('refuses another operator, a ticket that is not active and a missing room server', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    expect(
      (await hq.call('POST', `/v1/desk/tickets/${ticket.id}/token`, { user: 'asha', payload: {} }))
        .statusCode,
    ).toBe(403);
    await accept(hq, ticket, 'asha');
    expect(
      (await hq.call('POST', `/v1/desk/tickets/${ticket.id}/token`, { user: 'ravi', payload: {} }))
        .statusCode,
    ).toBe(403);
    const none = make({ noRooms: true });
    const queue = await makeQueue(none, managed({ name: 'Q' }));
    await onlineOperator(none, 'asha');
    const t = await openTicket(none, queue);
    await accept(none, t, 'asha');
    const unavailable = await none.call('POST', `/v1/desk/tickets/${t.id}/token`, {
      user: 'asha',
      payload: {},
    });
    expect([unavailable.statusCode, unavailable.json().error.code]).toEqual([
      503,
      'room_unavailable',
    ]);
  });

  it('removes the operator from the room when they leave, for the worker to notice', async () => {
    const hq = make();
    const { ticket } = await floor(hq);
    await accept(hq, ticket, 'asha');
    const roomName = `ovo-hq-${ticket.id}`;
    await hq.rooms!.room.ensureRoom({
      name: roomName,
      maxParticipants: 3,
      emptyTimeoutSeconds: 60,
    });
    const { token } = await hq.rooms!.room.mintToken({
      room: roomName,
      identity: 'op:asha',
      name: 'Asha',
      role: 'operator',
      ttlSeconds: 60,
    });
    const joined = await hq.rooms!.connect({
      token,
      room: roomName,
      format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 } as never,
    });
    const response = await hq.call('POST', `/v1/desk/tickets/${ticket.id}/release`, {
      user: 'asha',
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(joined.connected).toBe(false);
    expect((await hq.service.tickets.get(ticket.id))!.status).toBe('accepted');
    expect(hq.audits.at(-1)).toMatchObject({ action: 'desk.leave' });
  });
});
