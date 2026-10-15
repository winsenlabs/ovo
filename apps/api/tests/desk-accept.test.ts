import { afterEach, describe, expect, it } from 'vitest';
import {
  humanQueueApp,
  makeQueue,
  managed,
  onlineOperator,
  openTicket,
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

async function waiting(hq: HqApp, queuePatch: Record<string, unknown> = {}) {
  const queue = await makeQueue(
    hq,
    managed({ name: 'Support', teamIds: ['support'], ...queuePatch }),
  );
  await onlineOperator(hq, 'asha', { teamIds: ['support'] });
  const ticket = await openTicket(hq, queue);
  return { queue, ticket };
}
const accept = (
  hq: HqApp,
  ticket: { id: string; version: number },
  user: string,
  key = `key-${user}`,
  version = ticket.version,
) =>
  hq.call('POST', `/v1/desk/tickets/${ticket.id}/accept`, {
    user,
    payload: { expectedVersion: version, idempotencyKey: key },
  });

describe('POST /v1/desk/tickets/:id/accept', () => {
  it('accepts, makes the room and returns a grant, the ticket and the full context', async () => {
    const hq = make();
    const { ticket } = await waiting(hq);
    const response = await accept(hq, ticket, 'asha');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const result = response.json();
    expect(result.ticket).toMatchObject({
      id: ticket.id,
      status: 'accepted',
      assignedOperatorId: 'asha',
      version: ticket.version + 1,
    });
    expect(result.context).toMatchObject({
      caller: { number: '+919800000000' },
      summary: 'Caller asks about a charge.',
    });
    expect(result.room).toMatchObject({
      provider: 'fake-room',
      serverUrl: 'wss://rooms.fake.test',
      roomName: `ovo-hq-${ticket.id}`,
      identity: 'op:asha',
      role: 'operator',
    });
    expect(hq.rooms!.roomNames()).toEqual([`ovo-hq-${ticket.id}`]);
    expect((await hq.service.tickets.get(ticket.id))!.roomName).toBe(`ovo-hq-${ticket.id}`);
    expect(hq.audits.at(-1)).toMatchObject({ action: 'desk.accept', resourceId: ticket.id });
  });

  it('mints a token for this room only: audio, 120 seconds, no data, no admin', async () => {
    const hq = make();
    const { ticket } = await waiting(hq);
    const { room } = (await accept(hq, ticket, 'asha')).json();
    const claims = await hq.rooms!.claimsOf(room.token);
    expect(claims).toMatchObject({
      room: `ovo-hq-${ticket.id}`,
      identity: 'op:asha',
      name: 'ASHA',
      canJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      publishSources: ['microphone'],
      roomAdmin: false,
      roomCreate: false,
      roomList: false,
      hidden: false,
    });
    expect(claims.expiresAtMs - claims.issuedAtMs).toBeLessThanOrEqual(121_000);
    expect(Date.parse(room.expiresAt) - Date.now()).toBeLessThanOrEqual(121_000);
    const joined = await hq.rooms!.connect({
      token: room.token,
      room: room.roomName,
      format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 } as never,
    });
    expect(joined.connected).toBe(true);
    await joined.close();
  });

  it('honours the configured token lifetime', async () => {
    const hq = make({ tokenTtlSeconds: 45 });
    const { ticket } = await waiting(hq);
    const { room } = (await accept(hq, ticket, 'asha')).json();
    const claims = await hq.rooms!.claimsOf(room.token);
    expect(claims.expiresAtMs - claims.issuedAtMs).toBeLessThanOrEqual(46_000);
    expect(claims.expiresAtMs - claims.issuedAtMs).toBeGreaterThanOrEqual(44_000);
  });

  it('repeats safely: the same key by the same operator returns the same ticket and a usable token', async () => {
    const hq = make();
    const { ticket } = await waiting(hq);
    const first = await accept(hq, ticket, 'asha', 'one');
    const again = await accept(hq, ticket, 'asha', 'one');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().ticket.id).toBe(first.json().ticket.id);
    expect((await hq.rooms!.claimsOf(again.json().room.token)).identity).toBe('op:asha');
    expect((await accept(hq, ticket, 'asha', 'two')).statusCode).toBe(409);
  });

  it('answers 409 conflict with the ticket as it is when the version is stale or the call is taken', async () => {
    const hq = make();
    const { queue, ticket } = await waiting(hq);
    await onlineOperator(hq, 'meera', { teamIds: ['support'] });
    const stale = await accept(hq, ticket, 'asha', 'k', 99);
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'conflict']);
    expect(stale.json().current).toMatchObject({ id: ticket.id, status: 'waiting' });
    expect((await accept(hq, ticket, 'asha')).statusCode).toBe(200);
    const taken = await accept(hq, ticket, 'meera');
    expect([taken.statusCode, taken.json().error.code]).toEqual([409, 'conflict']);
    expect(taken.json().current).toBeNull();
    void queue;
  });

  it('answers 409 at_capacity when the operator already holds as many calls as they may', async () => {
    const hq = make();
    const { queue, ticket } = await waiting(hq);
    const second = await openTicket(hq, queue);
    expect((await accept(hq, ticket, 'asha')).statusCode).toBe(200);
    const refused = await accept(hq, second, 'asha');
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'at_capacity']);
    expect((await hq.service.tickets.get(second.id))!.status).toBe('waiting');
  });

  it('answers 403 not_eligible for an operator outside the queue’s teams or offline', async () => {
    const hq = make();
    const { ticket } = await waiting(hq);
    await onlineOperator(hq, 'ravi', { teamIds: ['billing'] });
    const wrongTeam = await accept(hq, ticket, 'ravi');
    expect([wrongTeam.statusCode, wrongTeam.json().error.code]).toEqual([403, 'not_eligible']);
    hq.service.clock.advance(60_000);
    const offline = await accept(hq, ticket, 'asha');
    expect([offline.statusCode, offline.json().error.code]).toEqual([403, 'not_eligible']);
  });

  it('404s an unknown ticket and a webhook queue’s ticket, and 400s a bad body', async () => {
    const hq = make();
    await waiting(hq);
    expect(
      (await accept(hq, { id: '00000000-0000-4000-8000-000000000009', version: 1 }, 'asha'))
        .statusCode,
    ).toBe(404);
    const acd = await makeQueue(hq, {
      kind: 'external',
      name: 'ACD',
      webhook: { url: 'https://acd.example.com/h', credentialId: 'acd-hmac' },
      destination: { allowE164Prefixes: ['+91'] },
    });
    const external = await openTicket(hq, acd);
    expect((await accept(hq, external, 'asha')).statusCode).toBe(404);
    const bad = await hq.call('POST', `/v1/desk/tickets/${external.id}/accept`, {
      user: 'asha',
      payload: { expectedVersion: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('needs an operator profile', async () => {
    const hq = make();
    const { ticket } = await waiting(hq);
    expect((await accept(hq, ticket, 'nobody')).statusCode).toBe(403);
  });
});

describe('when the room cannot be made', () => {
  it('answers 503 room_unavailable and leaves the ticket exactly as it was', async () => {
    const hq = make();
    const { ticket } = await waiting(hq);
    hq.rooms!.ensureRoom = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const response = await accept(hq, ticket, 'asha');
    expect([response.statusCode, response.json().error.code]).toEqual([503, 'room_unavailable']);
    expect(JSON.stringify(response.json())).not.toContain('ECONNREFUSED');
    const after = (await hq.service.tickets.get(ticket.id))!;
    expect([after.status, after.version, after.assignedOperatorId]).toEqual([
      'waiting',
      ticket.version,
      undefined,
    ]);
    expect((await hq.call('GET', '/v1/desk/tickets', { user: 'asha' })).json().items).toHaveLength(
      1,
    );
  });

  it('does the same when no room server is composed', async () => {
    const hq = make({ noRooms: true });
    const { ticket } = await waiting(hq);
    const response = await accept(hq, ticket, 'asha');
    expect([response.statusCode, response.json().error.code]).toEqual([503, 'room_unavailable']);
    expect((await hq.service.tickets.get(ticket.id))!.status).toBe('waiting');
  });

  it('distrusts a cached healthy verdict after a failed accept', async () => {
    const hq = make();
    const { ticket } = await waiting(hq);
    expect((await hq.call('GET', '/v1/human-queues/status')).json().room.reachable).toBe(true);
    const healthy = hq.rooms!.health.bind(hq.rooms);
    hq.rooms!.setHealthy(false);
    hq.rooms!.ensureRoom = async () => {
      throw new Error('down');
    };
    await accept(hq, ticket, 'asha');
    expect((await hq.call('GET', '/v1/human-queues/status')).json().room.reachable).toBe(false);
    void healthy;
  });
});

describe('concurrent accepts', () => {
  it('lets exactly one of several operators win a call, every time', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed({ name: 'Floor' }));
    const operators = ['a', 'b', 'c', 'd'];
    for (const id of operators) await onlineOperator(hq, id);
    for (let round = 0; round < 6; round += 1) {
      const ticket = await openTicket(hq, queue);
      const results = await Promise.all(
        operators.map((id) => accept(hq, ticket, id, `round-${round}-${id}`)),
      );
      expect(results.map((r) => r.statusCode).sort(), `round ${round}`).toEqual([
        200, 409, 409, 409,
      ]);
      const winner = results.findIndex((r) => r.statusCode === 200);
      expect((await hq.service.tickets.get(ticket.id))!.assignedOperatorId).toBe(operators[winner]);
      await hq.service.tickets.release({
        workspaceId: WORKSPACE,
        ticketId: ticket.id,
        expectedVersion: (await hq.service.tickets.get(ticket.id))!.version,
        reason: 'completed',
        idempotencyKey: `done-${round}`,
        code: 'completed',
        by: 'worker',
      });
    }
  });
});
