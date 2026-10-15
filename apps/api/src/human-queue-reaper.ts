import type { MediaRoomProvider } from '@winsendotai/ovo-contracts';
import type { ApiHumanQueueService } from './routes/human-queue-support.ts';
import { operatorIdentity } from './routes/desk-grant.ts';

export interface ReaperLog {
  warn(object: unknown, message: string): void;
}

/**
 * Closes the rooms of ended managed tickets (design 5.4). The worker deletes its room on a clean
 * end; this covers a worker that died, an operator who never left, and a ticket the sweeper
 * released. A room is closed by removing the operator and deleting the room (both idempotent) and
 * then recording `room_closed` on the ticket so it is not visited again. One failure is logged and
 * retried on the next pass; it never stops the others.
 */
export async function reapRooms(
  queues: ApiHumanQueueService,
  rooms: MediaRoomProvider,
  log: ReaperLog,
  limit = 50,
): Promise<number> {
  const pending = (await queues.tickets.roomsToClose?.(limit)) ?? [];
  let closed = 0;
  for (const ticket of pending) {
    try {
      if (ticket.operatorId)
        await rooms.removeParticipant(ticket.roomName, operatorIdentity(ticket.operatorId));
      await rooms.deleteRoom(ticket.roomName);
      await queues.tickets.appendEvent(ticket.id, { kind: 'room_closed', payload: {} });
      closed += 1;
    } catch (error) {
      log.warn({ err: error, ticket: ticket.id }, 'human queue room could not be closed');
    }
  }
  return closed;
}

/** Runs `reapRooms` every `intervalMs` (default 10 s), never two at once. Returns the stop function. */
export function startRoomReaper(
  queues: ApiHumanQueueService,
  rooms: MediaRoomProvider,
  log: ReaperLog,
  intervalMs = 10_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    reapRooms(queues, rooms, log)
      .catch((error: unknown) => log.warn({ err: error }, 'human queue room reaper failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
