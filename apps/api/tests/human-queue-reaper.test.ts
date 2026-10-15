import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { reapRooms, startRoomReaper } from '../src/human-queue-reaper.ts';
import type { ApiHumanQueueService } from '../src/routes/human-queue-support.ts';
import {
  humanQueueApp,
  makeQueue,
  managed,
  onlineOperator,
  openTicket,
  WORKSPACE,
} from './human-queue-fixtures.ts';

const log = { warn: vi.fn() };
afterEach(() => {
  vi.useRealTimers();
  log.warn.mockReset();
});

const FORMAT = { encoding: 'mulaw', sampleRate: 8000, channels: 1 } as never;

/** A service whose ended tickets are `pending`; `closed` records what the reaper marked. */
function fakeQueues(pending: { id: string; roomName: string; operatorId?: string }[]) {
  const closed: string[] = [];
  const queues = {
    tickets: {
      roomsToClose: vi.fn(async () => pending.filter((p) => !closed.includes(p.id))),
      appendEvent: vi.fn(async (id: string, event: { kind: string }) => {
        if (event.kind === 'room_closed') closed.push(id);
        return 'recorded' as const;
      }),
    },
  } as unknown as ApiHumanQueueService;
  return { queues, closed };
}

describe('reapRooms', () => {
  it('removes the operator, deletes the room and marks the ticket so it is not visited again', async () => {
    const rooms = fakeMediaRoom();
    await rooms.ensureRoom({ name: 'ovo-hq-a', maxParticipants: 3, emptyTimeoutSeconds: 60 });
    const { token } = await rooms.mintToken({
      room: 'ovo-hq-a',
      identity: 'op:asha',
      name: 'A',
      role: 'operator',
      ttlSeconds: 60,
    });
    const operator = await rooms.connect({ token, room: 'ovo-hq-a', format: FORMAT });
    const { queues, closed } = fakeQueues([{ id: 'a', roomName: 'ovo-hq-a', operatorId: 'asha' }]);
    expect(await reapRooms(queues, rooms, log)).toBe(1);
    expect(operator.connected).toBe(false);
    expect(rooms.roomNames()).toEqual([]);
    expect(closed).toEqual(['a']);
    expect(await reapRooms(queues, rooms, log)).toBe(0);
  });

  it('closes a room nobody joined, and a room that is already gone', async () => {
    const rooms = fakeMediaRoom();
    await rooms.ensureRoom({ name: 'ovo-hq-b', maxParticipants: 3, emptyTimeoutSeconds: 60 });
    const { queues, closed } = fakeQueues([
      { id: 'b', roomName: 'ovo-hq-b' },
      { id: 'c', roomName: 'ovo-hq-never-made', operatorId: 'ravi' },
    ]);
    expect(await reapRooms(queues, rooms, log)).toBe(2);
    expect(closed).toEqual(['b', 'c']);
  });

  it('logs a room it could not close, leaves it for the next pass and carries on', async () => {
    const rooms = fakeMediaRoom();
    const real = rooms.deleteRoom.bind(rooms);
    rooms.deleteRoom = async (name: string) => {
      if (name === 'ovo-hq-bad') throw new Error('server down');
      return real(name);
    };
    const { queues, closed } = fakeQueues([
      { id: 'bad', roomName: 'ovo-hq-bad' },
      { id: 'ok', roomName: 'ovo-hq-ok' },
    ]);
    expect(await reapRooms(queues, rooms, log)).toBe(1);
    expect(closed).toEqual(['ok']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: 'bad' }),
      expect.any(String),
    );
    expect(await reapRooms(queues, rooms, log)).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the service cannot list rooms to close', async () => {
    const queues = { tickets: {} } as unknown as ApiHumanQueueService;
    expect(await reapRooms(queues, fakeMediaRoom(), log)).toBe(0);
  });
});

describe('startRoomReaper', () => {
  it('runs on an interval, never two passes at once, and stops when told', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const roomsToClose = vi.fn(async () => {
      await gate;
      return [];
    });
    const queues = {
      tickets: { roomsToClose, appendEvent: vi.fn() },
    } as unknown as ApiHumanQueueService;
    const stop = startRoomReaper(queues, fakeMediaRoom(), log, 1_000);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(roomsToClose).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(roomsToClose).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(roomsToClose).toHaveBeenCalledTimes(2);
  });

  it('survives a pass that throws', async () => {
    vi.useFakeTimers();
    const roomsToClose = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue([]);
    const queues = {
      tickets: { roomsToClose, appendEvent: vi.fn() },
    } as unknown as ApiHumanQueueService;
    const stop = startRoomReaper(queues, fakeMediaRoom(), log, 1_000);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(roomsToClose).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
    stop();
  });
});

describe('the reaper in the app', () => {
  it('starts with a room server and a human queue service, and stops with the app', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const hq = humanQueueApp();
    await hq.app.ready();
    expect(setSpy.mock.calls.some(([, ms]) => ms === 10_000)).toBe(true);
    await hq.app.close();
    expect(clearSpy).toHaveBeenCalled();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('does not start without a room server or while the feature is off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    for (const options of [{ noRooms: true }, { enabled: false }]) {
      const hq = humanQueueApp(options);
      await hq.app.ready();
      await hq.app.close();
    }
    expect(setSpy.mock.calls.filter(([, ms]) => ms === 10_000)).toEqual([]);
    setSpy.mockRestore();
  });

  it('closes the room of a ticket that ended while the operator was in it (end to end with the fake room)', async () => {
    const hq = humanQueueApp();
    const queue = await makeQueue(hq, managed({ name: 'Floor' }));
    await onlineOperator(hq, 'asha');
    const ticket = await openTicket(hq, queue);
    const accepted = await hq.call('POST', `/v1/desk/tickets/${ticket.id}/accept`, {
      user: 'asha',
      payload: { expectedVersion: ticket.version, idempotencyKey: 'k' },
    });
    expect(accepted.statusCode).toBe(200);
    const roomName = accepted.json().room.roomName;
    const operator = await hq.rooms!.connect({
      token: accepted.json().room.token,
      room: roomName,
      format: FORMAT,
    });
    await hq.service.tickets.release({
      workspaceId: WORKSPACE,
      ticketId: ticket.id,
      expectedVersion: (await hq.service.tickets.get(ticket.id))!.version,
      reason: 'call_ended',
      idempotencyKey: 'r',
      code: 'worker_lost',
      by: 'sweeper',
    });
    // The service in this lane's base does not list rooms to close yet: the reaper is handed the same fact.
    const queues = {
      tickets: {
        roomsToClose: async () => [{ id: ticket.id, roomName, operatorId: 'asha' }],
        appendEvent: hq.service.tickets.appendEvent,
      },
    } as unknown as ApiHumanQueueService;
    expect(await reapRooms(queues, hq.rooms!, log)).toBe(1);
    expect(operator.connected).toBe(false);
    expect(hq.rooms!.roomNames()).toEqual([]);
  });
});
