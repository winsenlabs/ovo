import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { HumanQueue } from '@winsendotai/ovo-contracts';
import { HumanQueueNameTakenError } from '@winsendotai/ovo-plugin-operations';
import {
  invalid,
  queued,
  zodIssues,
  type HumanQueueRouteDependencies,
} from './human-queue-support.ts';
import {
  etag,
  routingPage,
  sendError,
  staleConflict,
  type RoutingAudit,
} from './routing-support.ts';
import { validateQueueDefinition } from '../human-queue-validate.ts';

const QueueParams = z.object({ queueId: z.uuid() });
const QueueBody = z.object({ definition: z.unknown() }).strict();

const notFound = (reply: FastifyReply) =>
  sendError(reply, 404, 'queue_not_found', 'Human queue not found');

/**
 * Queue administration (design 6.1): CRUD behind `If-Match` with a version etag, the queue's live
 * numbers and who binds it, and the deletion guard. Validation answers 422 with issue lists.
 */
export function registerHumanQueueRoutes(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit },
): void {
  const { app, audit } = input;

  app.get(
    '/v1/human-queues',
    queued(input, 'viewer', async ({ request, queues }) => {
      const page = await routingPage(request, (limit, cursor) => queues.queues.list(limit, cursor));
      return {
        ...page,
        items: await Promise.all(
          page.items.map(async (row: HumanQueue) => ({
            ...row,
            stats: await queues.queues.stats(row.id),
            usedBy: await queues.queues.usedBy(row.id),
          })),
        ),
      };
    }),
  );

  app.post(
    '/v1/human-queues',
    queued(input, 'editor', async ({ request, reply, principal, queues }) => {
      const body = QueueBody.safeParse(request.body ?? {});
      if (!body.success)
        return invalid(reply, 'queue_invalid', 'Request body is invalid', zodIssues(body.error));
      const checked = await validateQueueDefinition(body.data.definition, {
        store: input.store,
        workspaceId: principal.workspaceId,
      });
      if (!checked.ok)
        return invalid(reply, 'queue_invalid', 'Human queue definition is invalid', checked.issues);
      try {
        const created = await queues.queues.create(checked.definition);
        await audit(principal, 'human_queue.create', 'human_queue', created.id, {
          kind: created.definition.kind,
          version: created.version,
        });
        return reply.code(201).header('etag', etag(created.version)).send(created);
      } catch (error) {
        if (error instanceof HumanQueueNameTakenError)
          return sendError(reply, 409, 'queue_name_taken', 'Another queue has this name');
        throw error;
      }
    }),
  );

  app.get(
    '/v1/human-queues/:queueId',
    queued(input, 'viewer', async ({ request, reply, queues }) => {
      const { queueId } = QueueParams.parse(request.params);
      const found = await queues.queues.get(queueId);
      if (!found) return notFound(reply);
      return reply.header('etag', etag(found.version)).send({
        ...found,
        stats: await queues.queues.stats(queueId),
        usedBy: await queues.queues.usedBy(queueId),
      });
    }),
  );

  app.put(
    '/v1/human-queues/:queueId',
    queued(input, 'editor', async ({ request, reply, principal, queues }) => {
      const { queueId } = QueueParams.parse(request.params);
      const expected = input.expectedVersion(request);
      const body = QueueBody.safeParse(request.body ?? {});
      if (!body.success)
        return invalid(reply, 'queue_invalid', 'Request body is invalid', zodIssues(body.error));
      const existing = await queues.queues.get(queueId);
      if (!existing) return notFound(reply);
      const checked = await validateQueueDefinition(body.data.definition, {
        store: input.store,
        workspaceId: principal.workspaceId,
      });
      if (!checked.ok)
        return invalid(reply, 'queue_invalid', 'Human queue definition is invalid', checked.issues);
      if (checked.definition.kind !== existing.definition.kind)
        return invalid(reply, 'queue_invalid', 'A queue cannot change its type', [
          { path: ['kind'], message: 'Create a new queue of the other type instead' },
        ]);
      try {
        const updated = await queues.queues.update(queueId, checked.definition, expected);
        if (!updated)
          return staleConflict(
            reply,
            'queue_conflict',
            'Human queue changed',
            queues.queues.get(queueId),
          );
        await audit(principal, 'human_queue.update', 'human_queue', queueId, {
          version: updated.version,
        });
        return reply.header('etag', etag(updated.version)).send(updated);
      } catch (error) {
        if (error instanceof HumanQueueNameTakenError)
          return sendError(reply, 409, 'queue_name_taken', 'Another queue has this name');
        throw error;
      }
    }),
  );

  app.delete(
    '/v1/human-queues/:queueId',
    queued(input, 'editor', async ({ request, reply, principal, queues }) => {
      const { queueId } = QueueParams.parse(request.params);
      const expected = input.expectedVersion(request);
      if (!(await queues.queues.get(queueId))) return notFound(reply);
      const removed = await queues.queues.remove(queueId, expected);
      if (removed === 'conflict')
        return staleConflict(
          reply,
          'queue_conflict',
          'Human queue changed',
          queues.queues.get(queueId),
        );
      if (removed !== 'removed')
        return sendError(reply, 409, 'queue_in_use', 'Routing points still bind this queue', {
          inUseBy: removed.inUseBy,
        });
      await audit(principal, 'human_queue.delete', 'human_queue', queueId, { version: expected });
      return reply.code(204).send();
    }),
  );
}
