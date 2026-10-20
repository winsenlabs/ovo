import { describe, expect, it } from 'vitest';
import { humanRoomName } from '@winsendotai/ovo-contracts';
import { useHarness, ticketKit, externalDefinition, ticketFor, type HqHarness } from './harness.ts';
import type { Ticket } from '../../src/human-queue/service.ts';

/** The reads the API's desk stream and room reaper make (`head`, `roomsToClose`). */
export function describeRooms(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const { tickets, queueOf, operator, open, accept, get } = ticketKit(h);

  const end = (ticket: Pick<Ticket, 'id' | 'version'>) =>
    tickets().release({
      workspaceId: h.org,
      ticketId: ticket.id,
      expectedVersion: ticket.version,
      reason: 'completed',
      idempotencyKey: `end-${ticket.id}`,
      code: 'completed',
      by: 'worker',
    });

  describe('change head and rooms to close', () => {
    it('reports the newest change id: 0 when empty, moving with a change, still for a heartbeat', async () => {
      expect(await tickets().head()).toBe(0);
      const queue = await queueOf();
      const ticket = await open(queue);
      const created = await tickets().head();
      expect(created).toBeGreaterThan(0);
      await tickets().workerBeat(ticket.id);
      expect(await tickets().head()).toBe(created);
      await operator('asha');
      await accept(ticket, 'asha');
      expect(await tickets().head()).toBeGreaterThan(created);
    });

    it('lists the rooms of ended managed tickets once, by ticket age, and not a live one', async () => {
      const queue = await queueOf();
      await operator('asha', { capacity: 3 });
      const first = (await accept(await open(queue), 'asha')) as Ticket;
      h.clock.advance(1_000);
      const second = (await accept(await open(queue), 'asha')) as Ticket;
      h.clock.advance(1_000);
      const live = (await accept(await open(queue), 'asha')) as Ticket;
      expect(await tickets().roomsToClose(10)).toEqual([]);

      await end(second);
      h.clock.advance(1_000);
      await end(first);
      const found = await tickets().roomsToClose(10);
      expect(found.map((room) => room.id)).toEqual([first.id, second.id]);
      expect(found[1]).toEqual({
        id: second.id,
        roomName: `ovo-hq-${second.id}`,
        operatorId: 'asha',
      });
      expect(found.map((room) => room.id)).not.toContain(live.id);
      expect(await tickets().roomsToClose(1)).toHaveLength(1);

      expect(await tickets().appendEvent(second.id, { kind: 'room_closed', payload: {} })).toBe(
        'recorded',
      );
      expect((await tickets().roomsToClose(10)).map((room) => room.id)).toEqual([first.id]);
    });

    it('never lists a ticket that had no room: unanswered, or a third party’s', async () => {
      const queue = await queueOf();
      const unanswered = await open(queue);
      await end(unanswered);
      const external = await h.service.queues.create(externalDefinition());
      const handedOff = await tickets().create(ticketFor(external));
      if (handedOff === 'queue_full') throw new Error('queue_full');
      await end(handedOff);
      expect(await tickets().roomsToClose(10)).toEqual([]);
    });

    it("gives each accept its own room, and refuses a room that is not the ticket's", async () => {
      const queue = await queueOf();
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue);
      const grant = (version: number, roomName: string, operatorId: string) =>
        tickets().accept({
          workspaceId: h.org,
          ticketId: ticket.id,
          operatorId,
          expectedVersion: version,
          idempotencyKey: `k-${operatorId}`,
          roomName,
        });
      await expect(grant(1, 'ovo-hq-someone-else-2', 'asha')).rejects.toThrow(RangeError);
      await expect(grant(1, `${humanRoomName(ticket.id)}x`, 'asha')).rejects.toThrow(RangeError);
      const first = (await grant(1, humanRoomName(ticket.id, 2), 'asha')) as Ticket;
      expect(first.roomName).toBe(`ovo-hq-${ticket.id}-2`);
      const waiting = (await tickets().reoffer(
        ticket.id,
        first.version,
        'operator_no_show',
      )) as Ticket;
      const second = (await grant(
        waiting.version,
        humanRoomName(ticket.id, waiting.version + 1),
        'ben',
      )) as Ticket;
      // asha's token (for the first room) opens a room the ticket no longer uses.
      expect(second.roomName).toBe(`ovo-hq-${ticket.id}-4`);
      expect(second.roomName).not.toBe(first.roomName);
      expect((await get(ticket.id)).roomName).toBe(second.roomName);
      // Without a name the first design's room is still used.
      const legacy = await open(queue);
      expect(((await accept(legacy, 'asha')) as Ticket).roomName).toBe(`ovo-hq-${legacy.id}`);
    });
  });
}
