import { randomUUID } from 'node:crypto';
import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reapRooms } from '../src/human-queue-reaper.ts';
import { createOperationsRuntime, type OperationsRuntime } from '../src/operations-runtime.ts';
import { humanQueuesOf } from '../src/routes/human-queue-support.ts';
import { makeQueue, managed, onlineOperator, openTicket } from './human-queue-data.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const log = { warn: vi.fn() };

/** The room reaper over the real PostgreSQL human queue service, not a hand-made fake of it. */
describe.skipIf(!databaseUrl)('room reaper on the operations database', () => {
  const organizationId = `reaper-${randomUUID()}`;
  let runtime: OperationsRuntime;

  beforeAll(async () => {
    runtime = await createOperationsRuntime({
      organizationId,
      databaseUrl,
      humanQueueEnabled: true,
    });
  });
  afterAll(async () => runtime?.close?.());

  // Red, on purpose, until core's HumanQueueService has `roomsToClose` and `head` (the cross-lane
  // request in the wave 17 api report): without them the reaper does nothing against PostgreSQL.
  it('has the service members the reaper and the desk stream need', () => {
    const { tickets } = humanQueuesOf(runtime.service)!;
    expect(typeof tickets.roomsToClose).toBe('function');
    expect(typeof tickets.head).toBe('function');
  });

  it('closes the room of a released ticket once, and leaves a live ticket’s room alone', async () => {
    const service = humanQueuesOf(runtime.service)!;
    const hq = { service, now: () => Date.now() };
    const queue = await makeQueue(hq, managed({ name: 'Support', teamIds: ['support'] }));
    await onlineOperator(hq, 'asha', { teamIds: ['support'] });
    await onlineOperator(hq, 'meera', { teamIds: ['support'] });
    const rooms = fakeMediaRoom();
    const take = async (operatorId: string) => {
      const ticket = await openTicket(hq, queue);
      const accepted = await service.tickets.accept({
        workspaceId: organizationId,
        ticketId: ticket.id,
        operatorId,
        expectedVersion: ticket.version,
        idempotencyKey: `accept-${operatorId}`,
      });
      if (!('id' in accepted)) throw new Error(accepted.kind);
      await rooms.ensureRoom({
        name: accepted.roomName!,
        maxParticipants: 3,
        emptyTimeoutSeconds: 60,
      });
      return accepted;
    };
    const accepted = await take('asha');
    const live = await take('meera');
    const ended = accepted;
    expect(await service.tickets.roomsToClose!(10)).toEqual([]);

    await service.tickets.release({
      workspaceId: organizationId,
      ticketId: ended.id,
      expectedVersion: accepted.version,
      reason: 'completed',
      idempotencyKey: 'release-1',
      code: 'completed',
      by: 'operator',
    });
    expect((await service.tickets.roomsToClose!(10)).map((r) => r.id)).toEqual([ended.id]);

    expect(await reapRooms(service, rooms, log)).toBe(1);
    expect(rooms.roomNames()).toEqual([live.roomName]);
    expect(await service.tickets.roomsToClose!(10)).toEqual([]);
    expect(await reapRooms(service, rooms, log)).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('knows the newest change id, which moves when a ticket changes', async () => {
    const service = humanQueuesOf(runtime.service)!;
    const before = await service.tickets.head!();
    const queue = await makeQueue({ service }, managed({ name: 'Billing' }));
    await openTicket({ service, now: () => Date.now() }, queue);
    expect(await service.tickets.head!()).toBeGreaterThan(before);
  });
});
