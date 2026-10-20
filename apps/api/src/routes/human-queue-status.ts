import {
  humanQueuesOf,
  type HumanQueueRouteDependencies,
  type RoomHealth,
} from './human-queue-support.ts';

/**
 * `GET /v1/human-queues/status` (design 6.1): the one human queue route that answers while the
 * feature is off, so the console can say why it is unavailable instead of showing a bare 404.
 * `reachable` comes from a probe cached for 30 s; nothing here touches a call or a ticket.
 */
export function registerHumanQueueStatusRoute(
  input: HumanQueueRouteDependencies & { health: RoomHealth },
): void {
  input.app.get('/v1/human-queues/status', async (request) => {
    input.requireRole(request, 'viewer');
    const queues = input.flags.enabled ? humanQueuesOf(input.operations) : undefined;
    const enabled = queues !== undefined;
    const [room, sweeper] = await Promise.all([
      enabled ? input.health.check() : undefined,
      queues?.lastSweep?.(),
    ]);
    return {
      enabled,
      webhookEnabled: enabled && input.flags.webhookEnabled,
      managedAvailable: enabled && input.rooms !== undefined && room?.ok === true,
      room: {
        configured: input.rooms !== undefined,
        ...(input.rooms
          ? { provider: input.rooms.provider, publicUrl: input.rooms.publicUrl }
          : {}),
        ...(room ? { reachable: room.ok } : {}),
      },
      ...(sweeper ? { sweeper: { lastRunAt: sweeper } } : {}),
    };
  });
}
