import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { afterEach, describe, expect, it } from 'vitest';
import { type HqApp, WORKSPACE, humanQueueApp, useHq } from './human-queue-fixtures.ts';
import { makeQueue, managed, onlineOperator, openTicket, profile } from './human-queue-data.ts';

const make = useHq(fakeMediaRoom);

import { accept, floor } from './desk-support.ts';

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
