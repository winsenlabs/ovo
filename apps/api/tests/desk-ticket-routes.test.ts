import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { describe, expect, it } from 'vitest';
import { type HqApp, WORKSPACE, useHq } from './human-queue-fixtures.ts';
import { makeQueue, managed, onlineOperator, openTicket } from './human-queue-data.ts';
import { accept, floor } from './desk-support.ts';

const make = useHq(fakeMediaRoom);

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
