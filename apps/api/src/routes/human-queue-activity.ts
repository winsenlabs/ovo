import { z } from 'zod';
import { QUEUE_ACTIVITY_WINDOWS } from '@winsendotai/ovo-contracts';
import { queued, type HumanQueueRouteDependencies } from './human-queue-support.ts';
import { sendError, type RoutingAudit } from './routing-support.ts';

const ActivityParams = z.object({ queueId: z.uuid() });
const ActivityQuery = z.object({ window: z.enum(QUEUE_ACTIVITY_WINDOWS).default('24h') }).strict();

/**
 * `GET /v1/human-queues/:queueId/activity?window=24h|7d` (R4): what became of the tickets the queue
 * created in the window (taken, dropped, expired, failed; how long callers waited and talked) and
 * the newest 50. Ids, codes and timings only: never a caller number, a summary or a context.
 */
export function registerHumanQueueActivityRoute(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit },
): void {
  input.app.get(
    '/v1/human-queues/:queueId/activity',
    queued(input, 'viewer', async ({ request, reply, queues }) => {
      const { queueId } = ActivityParams.parse(request.params);
      const query = ActivityQuery.safeParse(request.query);
      if (!query.success)
        return sendError(reply, 422, 'queue_activity_invalid', 'The activity query is invalid', {
          issues: query.error.issues,
        });
      const activity = await queues.queues.activity(queueId, query.data.window);
      return activity ?? sendError(reply, 404, 'queue_not_found', 'Human queue not found');
    }),
  );
}
