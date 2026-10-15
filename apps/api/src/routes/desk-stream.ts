import { z } from 'zod';
import type { HumanTicketView } from '@winsendotai/ovo-contracts';
import { deskQueues, deskStats } from './desk-me.ts';
import {
  desked,
  type ApiHumanQueueService,
  type HumanQueueRouteDependencies,
} from './human-queue-support.ts';
import { sendError, type RoutingAudit } from './routing-support.ts';
import { delay, openSse, parseCursor, writeSse } from './sse.ts';

const StreamQuery = z.object({ cursor: z.coerce.number().int().min(0).optional() });
/** `changes` returns at most this many rows a call; a full page means there may be more. */
const PAGE = 200;
const PER_OPERATOR = 4;
const ME_EVERY_MS = 5_000;

const bound = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The newest change id: the service's own, else the end of a walk through its change feed. */
async function headOf(queues: ApiHumanQueueService, userId: string): Promise<number> {
  if (queues.tickets.head) return queues.tickets.head();
  let cursor = 0;
  for (let page = 0; page < 100; page += 1) {
    const next = await queues.tickets.changes(cursor, userId);
    cursor = next.cursor;
    if (next.items.length < PAGE) break;
  }
  return cursor;
}

/**
 * `GET /v1/desk/stream` (design 6.2): the operator's queue as server-sent events, following the
 * shape of `/v1/calls/:id/stream`. `ticket` carries a ticket view, `removed` an id that left the
 * operator's queue, `me` presence and numbers, `heartbeat` keeps the line warm and `gap` says the
 * client's cursor is from another life, so it should reload. The id of the last event of each
 * batch is the change cursor; `Last-Event-ID` (or `?cursor=`) resumes from it. A new stream
 * starts with a snapshot of the queue and the operator's own calls, then follows the change feed
 * every 500 ms.
 */
export function registerDeskStreamRoute(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit },
): void {
  const maxConnections = bound(input.sse?.maxConnections ?? 100, 1, 10_000);
  const pollMs = bound(input.sse?.pollMs ?? 500, 10, 5_000);
  const heartbeatMs = bound(input.sse?.heartbeatMs ?? 15_000, 10, 60_000);
  const maxBuffered = bound(input.sse?.maxBufferedBytes ?? 64 * 1024, 1_024, 1024 * 1024);
  const maxConnectionMs = 3_600_000;
  // Real time: a stream's heartbeats and lifetime are wall-clock, whatever clock the domain uses.
  const now = Date.now;
  let active = 0;
  const perUser = new Map<string, number>();

  input.app.get(
    '/v1/desk/stream',
    desked(input, async ({ request, reply, profile, queues }) => {
      const userId = profile.userId;
      if (active >= maxConnections || (perUser.get(userId) ?? 0) >= PER_OPERATOR)
        return sendError(reply, 429, 'stream_capacity', 'SSE connection limit reached');
      const resume =
        parseCursor(request.headers['last-event-id']) ?? StreamQuery.parse(request.query).cursor;
      const head = await headOf(queues, userId);
      let cursor = resume !== undefined && resume <= head ? resume : head;
      const stale = resume !== undefined && resume > head;
      const snapshot = resume === undefined || stale;

      active += 1;
      perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
      const sse = openSse(request, reply);
      const send = (chunk: string) => writeSse(sse.response, chunk, maxBuffered, sse.signal);
      const event = (name: string, data: unknown, id?: number) =>
        `${id === undefined ? '' : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      const batch = async (events: [string, unknown][], id: number) => {
        for (const [index, [name, data]] of events.entries())
          await send(event(name, data, index === events.length - 1 ? id : undefined));
      };

      const myQueueIds = async () =>
        (await deskQueues(input, queues, profile)).map((queue) => queue.id);
      let lastMe = '';
      const meEvent = async (): Promise<[string, unknown][]> => {
        const { status, stats } = await deskStats(queues, profile, await myQueueIds());
        const text = JSON.stringify({ status, stats });
        if (text === lastMe) return [];
        lastMe = text;
        return [['me', { status, stats }]];
      };

      const deadline = now() + maxConnectionMs;
      let lastWrite = 0;
      let lastMeAt = 0;
      try {
        if (stale) await send(event('gap', { cursor: resume, head }));
        if (snapshot) {
          const [queue, mine] = await Promise.all([
            queues.tickets.listForOperator(userId, 'queue'),
            queues.tickets.listForOperator(userId, 'mine'),
          ]);
          await batch(
            [...queue, ...mine]
              .map((view): [string, unknown] => ['ticket', view])
              .concat(await meEvent()),
            cursor,
          );
          lastWrite = lastMeAt = now();
        }
        while (!sse.signal.aborted && now() < deadline) {
          const next = await queues.tickets.changes(cursor, userId);
          if (next.items.length) {
            const events = await deltas(queues, userId, next.items);
            if (events.length) {
              await batch(events, next.cursor);
              lastWrite = now();
            }
          }
          cursor = next.cursor;
          if (next.items.length >= PAGE) continue;
          if (now() - lastMeAt >= ME_EVERY_MS) {
            lastMeAt = now();
            const me = await meEvent();
            if (me.length) {
              await batch(me, cursor);
              lastWrite = now();
            }
          }
          if (now() - lastWrite >= heartbeatMs) {
            await send(event('heartbeat', {}, cursor));
            lastWrite = now();
          }
          await delay(pollMs, sse.signal);
        }
      } catch (error) {
        if (!sse.signal.aborted && !sse.response.destroyed)
          sse.response.write(
            event('error', {
              message: error instanceof Error ? error.message.slice(0, 200) : 'stream failed',
            }),
          );
      } finally {
        active -= 1;
        perUser.set(userId, (perUser.get(userId) ?? 1) - 1);
        if (!perUser.get(userId)) perUser.delete(userId);
        sse.end();
      }
    }),
  );
}

/**
 * What a batch of changed tickets means to this operator: a ticket of theirs, or a waiting one
 * they may take, is a `ticket`; any other is gone from their view (`removed`). Whether a waiting
 * ticket is still theirs to take (not declined, not offered to someone else) is the queue list's
 * call, so it is asked once per batch that needs it.
 */
async function deltas(
  queues: ApiHumanQueueService,
  userId: string,
  items: readonly HumanTicketView[],
): Promise<[string, unknown][]> {
  const open = (view: HumanTicketView) => view.status === 'waiting' || view.status === 'offered';
  const needsVisible = items.some((view) => view.assignedOperatorId !== userId && open(view));
  const visible = needsVisible
    ? new Set((await queues.tickets.listForOperator(userId, 'queue')).map((view) => view.id))
    : new Set<string>();
  return items.map((view): [string, unknown] =>
    view.assignedOperatorId === userId || (open(view) && visible.has(view.id))
      ? ['ticket', view]
      : ['removed', { id: view.id }],
  );
}
