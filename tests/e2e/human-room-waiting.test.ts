import { describe, expect, it, vi } from 'vitest';
import { acceptTicket, addOperator, waitOffered, type Desk } from './support/desk-operator.ts';
import { HUMAN_LINES, floorHold } from './support/human-setup.ts';
import { at, hungUpByPlatform, of, pressWhenListening } from './support/human-call.ts';
import { joinAsOperator, roomsOf } from './support/room-audio.ts';
import { roomServerBinary, startRoomStack, type RoomStack } from './support/room-stack.ts';
import { LINES } from './support/routing-setup.ts';
import { heard, said, transferCall } from './support/transfer-call.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error('The human-room-waiting test needs OVO_TEST_POSTGRES_URL');

/** One installation for one case; each is closed before the next (connections add up). */
async function withRoom(
  options: Parameters<typeof startRoomStack>[2],
  run: (room: RoomStack) => Promise<void>,
) {
  const room = await startRoomStack(postgresUrl!, net.routes, options);
  try {
    await run(room);
  } finally {
    await room.close();
  }
}

const ticketRow = async (room: RoomStack, id: string) =>
  (
    await room.env.stack.db.query<Record<string, any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
      'SELECT status, version, release_code, assigned_operator_id, declined_by, room_name FROM ovo_hq_tickets WHERE id = $1',
      [id],
    )
  ).rows[0]!;

/** The router call to the desk queue: digit 3 once the router listens. */
async function toDesk(room: RoomStack, call: Parameters<Parameters<typeof transferCall>[1]>[0]) {
  await heard(room.env, call, LINES.greeting);
  await pressWhenListening(room.env, call, '3');
}

/** Joins the room with an accepted grant, lets a moment pass, and ends the call from the desk. */
async function talkAndEnd(
  desk: Desk,
  ticketId: string,
  grant: { serverUrl: string; token: string },
) {
  const operator = await joinAsOperator(grant);
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(
    (await desk.call('POST', `/v1/desk/tickets/${ticketId}/commands`, { kind: 'end_call' })).status,
  ).toBe(202);
  await vi.waitFor(() => expect(operator.disconnected).toBe(true), { timeout: 15_000 });
  await operator.disconnect();
}

describe.skipIf(!roomServerBinary())('managed human queue: the waiting paths (R3)', () => {
  it('8a. nobody online refuses no_operators and the router falls to its callback step', async () => {
    await withRoom(
      {
        line: {
          fallback: [
            { kind: 'callback', inMinutes: 30, line: { en: HUMAN_LINES.callback } },
            { kind: 'end', line: { en: HUMAN_LINES.end } },
          ],
        },
      },
      async (room) => {
        await addOperator(room.env, 'asha'); // enabled, but never AVAILABLE
        const result = await transferCall(
          room.env,
          async (call) => {
            await toDesk(room, call);
            await hungUpByPlatform(room.env, call);
          },
          { carrier: 'hangup' },
        );
        const { events } = result;
        at(events, 'human.requested', {
          kind: 'managed',
          result: 'refused',
          refusal: 'no_operators',
        });
        expect(of(events, 'human.state')).toEqual([]);
        expect(result.summary).toMatchObject({ outcome: 'completed', disposition: 'callback' });
        // Nothing was queued and no room was made for a caller nobody could answer.
        expect(await roomsOf(room.server).listRooms()).toEqual([]);
        const tickets = await room.env.stack.db.query('SELECT 1 FROM ovo_hq_tickets');
        expect(tickets.rowCount).toBe(0);
      },
    );
  });

  it('8b. an operator who never accepts: the offer lapses, the hold times out and the default agent answers', async () => {
    await withRoom({ line: { managed: { offerSeconds: 5, hold: floorHold(6) } } }, async (room) => {
      const desk = await addOperator(room.env, 'asha');
      await desk.presence('AVAILABLE');
      let ticketId = '';
      const result = await transferCall(room.env, async (call) => {
        await toDesk(room, call);
        const [ticket] = await waitOffered(desk);
        ticketId = ticket!.id;
        await heard(room.env, call, LINES.fallback);
      });
      const { events } = result;
      at(events, 'human.requested', { kind: 'managed', result: 'accepted' });
      at(events, 'human.completed', { outcome: 'timeout' });
      at(events, 'human.state', { state: 'released', code: 'timed_out' });
      const fallback = at(events, 'route.segment', { role: 'agent', reason: 'fallback' });
      expect(at(events, 'human.completed', { outcome: 'timeout' })).toBeLessThan(fallback);
      expect(await ticketRow(room, ticketId)).toMatchObject({
        status: 'released',
        release_code: 'timed_out',
        room_name: null,
      });
      expect(await desk.offered()).toEqual([]);
      expect(await roomsOf(room.server).listRooms()).toEqual([]);
    });
  });

  it('8c. a decline offers the call to the next operator, who accepts', async () => {
    await withRoom({}, async (room) => {
      const asha = await addOperator(room.env, 'asha');
      const bela = await addOperator(room.env, 'bela');
      await asha.presence('AVAILABLE');
      await bela.presence('AVAILABLE');
      let ticketId = '';
      await transferCall(
        room.env,
        async (call) => {
          await toDesk(room, call);
          const offeredTo = async (desk: Desk) => (await desk.offered())[0];
          let first: Desk | undefined;
          let ticket: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
          await vi.waitFor(
            async () => {
              for (const desk of [asha, bela]) {
                ticket = await offeredTo(desk);
                if (ticket) return void (first = desk);
              }
              throw new Error('nobody was offered the call');
            },
            { timeout: 30_000, interval: 250 },
          );
          ticketId = ticket!.id;
          const second = first === asha ? bela : asha;
          expect(
            (
              await first!.call('POST', `/v1/desk/tickets/${ticketId}/decline`, {
                expectedVersion: ticket!.version,
              })
            ).status,
          ).toBe(204);
          expect(await first!.offered()).toEqual([]);
          const [rotated] = await waitOffered(second);
          expect(rotated!.id).toBe(ticketId);
          expect(rotated!.version).toBeGreaterThan(ticket!.version);
          const accepted = await acceptTicket(second, rotated as never);
          expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
          const row = await ticketRow(room, ticketId);
          expect(row).toMatchObject({ status: 'accepted', assigned_operator_id: second.id });
          expect(row.declined_by).toEqual([first!.id]);
          await talkAndEnd(second, ticketId, accepted.body.room);
          await hungUpByPlatform(room.env, call);
        },
        { carrier: 'hangup' },
      );
    });
  });

  it('8d. an operator who accepts but never joins: the call is offered again (operator_no_show)', async () => {
    await withRoom({ line: { managed: { joinSeconds: 5 } } }, async (room) => {
      const asha = await addOperator(room.env, 'asha');
      const bela = await addOperator(room.env, 'bela');
      await asha.presence('AVAILABLE');
      await bela.presence('AVAILABLE');
      let ticketId = '';
      await transferCall(
        room.env,
        async (call) => {
          await toDesk(room, call);
          let first!: Desk;
          let ticket!: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
          await vi.waitFor(
            async () => {
              for (const desk of [asha, bela]) {
                const [offered] = await desk.offered();
                if (offered) return void ((first = desk), (ticket = offered));
              }
              throw new Error('nobody was offered the call');
            },
            { timeout: 30_000, interval: 250 },
          );
          ticketId = ticket.id;
          const taken = await acceptTicket(first, ticket as never);
          expect(taken.status).toBe(200);
          // The accepter never joins the room: after joinSeconds the call is waiting again.
          await vi.waitFor(
            async () => expect((await ticketRow(room, ticketId)).status).not.toBe('accepted'),
            {
              timeout: 30_000,
              interval: 250,
            },
          );
          const history = await room.env.stack.db.query<{
            kind: string;
            payload: Record<string, any>;
          }>('SELECT kind, payload FROM ovo_hq_ticket_events WHERE ticket_id = $1 ORDER BY seq', [
            // eslint-disable-line @typescript-eslint/no-explicit-any
            ticketId,
          ]);
          expect(history.rows.map((row) => [row.payload.state, row.payload.code ?? null])).toEqual([
            ['waiting', null],
            ['offered', null],
            ['accepted', null],
            ['waiting', 'operator_no_show'],
            ['offered', null],
          ]);
          expect(await ticketRow(room, ticketId)).toMatchObject({
            status: 'offered',
            declined_by: [first.id],
          });
          const other = first === asha ? bela : asha;
          const [again] = await waitOffered(other);
          expect(again!.id).toBe(ticketId);
          const accepted = await acceptTicket(other, again as never);
          expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
          // Each accept has its own room: the first operator's token, still valid, opens a room nobody bridges.
          expect(accepted.body.room.roomName).not.toBe(taken.body.room.roomName);
          await talkAndEnd(other, ticketId, accepted.body.room);
          await hungUpByPlatform(room.env, call);
        },
        { carrier: 'hangup' },
      );
    });
  });

  it('8e. two operators racing to accept an open-pickup call: exactly one wins', async () => {
    await withRoom({ line: { managed: { assignment: 'OPEN_PICKUP' } } }, async (room) => {
      const asha = await addOperator(room.env, 'asha');
      const bela = await addOperator(room.env, 'bela');
      await asha.presence('AVAILABLE');
      await bela.presence('AVAILABLE');
      await transferCall(
        room.env,
        async (call) => {
          await toDesk(room, call);
          const [mine] = await waitOffered(asha);
          const [theirs] = await waitOffered(bela);
          expect(theirs!.id).toBe(mine!.id);
          const [a, b] = await Promise.all([
            acceptTicket(asha, mine as never),
            acceptTicket(bela, theirs as never),
          ]);
          expect([a.status, b.status].sort()).toEqual([200, 409]);
          const [winner, loser, won] = a.status === 200 ? [asha, bela, a] : [bela, asha, b];
          expect((a.status === 409 ? a : b).body.error.code).toBe('conflict');
          expect((await ticketRow(room, mine!.id)).assigned_operator_id).toBe(winner.id);
          // The loser's desk no longer shows it as theirs to take.
          expect((await loser.offered()).filter((t) => t.offeredToMe)).toEqual([]);
          await talkAndEnd(winner, mine!.id, won.body.room);
          await hungUpByPlatform(room.env, call);
        },
        { carrier: 'hangup' },
      );
    });
  });

  it('8f. a caller who hangs up while waiting releases the ticket and no room is ever made', async () => {
    await withRoom({}, async (room) => {
      const desk = await addOperator(room.env, 'asha');
      await desk.presence('AVAILABLE');
      let ticketId = '';
      await transferCall(room.env, async (call, hangUp) => {
        await toDesk(room, call);
        const [ticket] = await waitOffered(desk);
        ticketId = ticket!.id;
        await hangUp();
      });
      await vi.waitFor(
        async () => expect((await ticketRow(room, ticketId)).status).toBe('released'),
        {
          timeout: 20_000,
          interval: 250,
        },
      );
      expect(await ticketRow(room, ticketId)).toMatchObject({
        status: 'released',
        release_code: 'call_ended',
        room_name: null,
      });
      expect(await desk.offered()).toEqual([]);
      expect(await roomsOf(room.server).listRooms()).toEqual([]);
      // A late accept of the ended call is refused.
      const late = await desk.call('POST', `/v1/desk/tickets/${ticketId}/accept`, {
        expectedVersion: 1,
        idempotencyKey: 'late',
      });
      expect([404, 409]).toContain(late.status);
    });
  });

  for (const leave of ['end_call', 'return_to_agent'] as const)
    it(`8g. an operator who closes the tab mid-call: after the grace the queue ${leave === 'end_call' ? 'ends the call' : 'returns the caller to the agent'}`, async () => {
      await withRoom(
        {
          line: {
            managed:
              leave === 'end_call'
                ? {}
                : { onOperatorLeave: 'return_to_agent', returnDefault: 'sales' },
          },
        },
        async (room) => {
          const desk = await addOperator(room.env, 'asha');
          await desk.presence('AVAILABLE');
          let ticketId = '';
          let left = 0;
          const result = await transferCall(
            room.env,
            async (call) => {
              await toDesk(room, call);
              const [ticket] = await waitOffered(desk);
              ticketId = ticket!.id;
              const accepted = await acceptTicket(desk, ticket as never);
              const operator = await joinAsOperator(accepted.body.room);
              await new Promise((resolve) => setTimeout(resolve, 1_500));
              await operator.disconnect();
              left = Date.now();
              if (leave === 'end_call') await hungUpByPlatform(room.env, call);
              else await said(room.env, call, HUMAN_LINES.sales);
              // The 5 s grace passed before anything happened to the call.
              expect(Date.now() - left).toBeGreaterThanOrEqual(3_000);
            },
            leave === 'end_call' ? { carrier: 'hangup' } : {},
          );
          const { events } = result;
          at(events, 'human.state', { state: 'released', code: 'operator_left' });
          const completed = at(events, 'human.completed', {
            outcome: leave === 'end_call' ? 'ended' : 'returned',
            operator: desk.id,
          });
          expect(Number(events[completed]!.payload.talkMs)).toBeGreaterThanOrEqual(5_000);
          expect(await ticketRow(room, ticketId)).toMatchObject({
            status: 'released',
            release_code: 'operator_left',
          });
          if (leave === 'return_to_agent')
            at(events, 'route.segment', {
              role: 'agent',
              reason: 'transfer',
              memberId: 'sales-en',
            });
          else at(events, 'call.outcome', { outcome: 'completed' });
          // The room was closed behind the operator who left.
          await vi.waitFor(
            async () =>
              expect((await roomsOf(room.server).listRooms()).map((r) => r.name)).not.toContain(
                `ovo-hq-${ticketId}`,
              ),
            { timeout: 20_000, interval: 500 },
          );
        },
      );
    });

  it('8h. a worker that stops reporting: the sweeper releases the ticket and the reaper closes the room', async () => {
    await withRoom({}, async (room) => {
      const desk = await addOperator(room.env, 'asha');
      await desk.presence('AVAILABLE');
      let ticketId = '';
      let operator!: Awaited<ReturnType<typeof joinAsOperator>>;
      const db = room.env.stack.db;
      try {
        await transferCall(
          room.env,
          async (call) => {
            await toDesk(room, call);
            const [ticket] = await waitOffered(desk);
            ticketId = ticket!.id;
            const accepted = await acceptTicket(desk, ticket as never);
            operator = await joinAsOperator(accepted.body.room);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            // The worker's heartbeat writes are lost from here on, as if the process had died.
            await db.query(`CREATE OR REPLACE FUNCTION e2e_freeze_heartbeat() RETURNS trigger AS $$
              BEGIN
                NEW.worker_heartbeat_at := now() - interval '10 minutes';
                RETURN NEW;
              END $$ LANGUAGE plpgsql`);
            await db.query(
              `CREATE TRIGGER e2e_freeze BEFORE UPDATE OF worker_heartbeat_at ON ovo_hq_tickets
                 FOR EACH ROW WHEN (OLD.id = '${ticketId}') EXECUTE FUNCTION e2e_freeze_heartbeat()`,
            );
            await db.query('UPDATE ovo_hq_tickets SET worker_heartbeat_at = now() WHERE id = $1', [
              ticketId,
            ]);
            await vi.waitFor(
              async () => expect((await ticketRow(room, ticketId)).status).toBe('released'),
              {
                timeout: 20_000,
                interval: 250,
              },
            );
            expect(await ticketRow(room, ticketId)).toMatchObject({
              status: 'released',
              release_code: 'worker_lost',
            });
            await vi.waitFor(
              async () =>
                expect((await roomsOf(room.server).listRooms()).map((r) => r.name)).not.toContain(
                  `ovo-hq-${ticketId}`,
                ),
              { timeout: 30_000, interval: 500 },
            );
            // The reaper recorded the room closed (it is not visited again).
            await vi.waitFor(
              async () =>
                expect(
                  (
                    await db.query(
                      "SELECT 1 FROM ovo_hq_ticket_events WHERE ticket_id = $1 AND kind = 'room_closed'",
                      [ticketId],
                    )
                  ).rowCount,
                ).toBe(1),
              { timeout: 20_000, interval: 500 },
            );
            // The reaper removed the operator along with the room.
            await vi.waitFor(() => expect(operator.disconnected).toBe(true), { timeout: 10_000 });
            await operator.disconnect();
            // The segment saw its ticket go and ended the call.
            await hungUpByPlatform(room.env, call);
          },
          { carrier: 'hangup' },
        );
      } finally {
        await db
          .query('DROP TRIGGER IF EXISTS e2e_freeze ON ovo_hq_tickets')
          .catch(() => undefined);
      }
    });
  });
});
