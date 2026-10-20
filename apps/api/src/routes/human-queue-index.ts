import { RateLimiter } from '../human-queue-ports.ts';
import { startRoomReaper } from '../human-queue-reaper.ts';
import { registerDeskAcceptRoute } from './desk-accept.ts';
import { registerDeskRoutes } from './desk.ts';
import { registerDeskStreamRoute } from './desk-stream.ts';
import { registerHumanQueueActivityRoute } from './human-queue-activity.ts';
import { registerHumanQueueCallbackRoutes } from './human-queue-callbacks.ts';
import { registerHumanQueueOperatorRoutes } from './human-queue-operators.ts';
import { registerHumanQueuePreviewRoutes } from './human-queue-preview.ts';
import { registerHumanQueueStatusRoute } from './human-queue-status.ts';
import {
  humanQueueAudit,
  humanQueuesOf,
  RoomHealth,
  type HumanQueueRouteDependencies,
} from './human-queue-support.ts';
import { registerHumanQueueRoutes } from './human-queues.ts';

/**
 * `/v1/human-queues/*`, `/v1/desk/*` and the third-party `/v1/human-queue/*` (Wave 17, design 6).
 * Ships dark: with `OVO_HUMAN_QUEUE_ENABLED` off only `GET /v1/human-queues/status` answers; every
 * other route is 404 `human_queue_disabled`. With a room server composed, a reaper closes the
 * rooms of ended tickets for the life of the app.
 */
export function registerHumanQueue(input: HumanQueueRouteDependencies): void {
  const audit = humanQueueAudit(input.store);
  const health = new RoomHealth(input.rooms, input.now);
  const full = { ...input, audit, health };
  registerHumanQueueStatusRoute(full);
  registerHumanQueuePreviewRoutes({ ...full, testLimiter: new RateLimiter(10, 60_000, input.now) });
  registerHumanQueueOperatorRoutes(full);
  registerHumanQueueRoutes(full);
  registerHumanQueueActivityRoute(full);
  registerDeskRoutes(full);
  registerDeskAcceptRoute(full);
  registerDeskStreamRoute(full);
  registerHumanQueueCallbackRoutes(full);

  const queues = input.flags.enabled ? humanQueuesOf(input.operations) : undefined;
  if (queues && input.rooms) {
    const stop = startRoomReaper(queues, input.rooms, {
      warn: (object, message) => input.app.log.warn(object as object, message),
    });
    input.app.addHook('onClose', async () => stop());
  }
}
