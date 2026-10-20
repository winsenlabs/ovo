import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { CallRecord, Page } from '@winsendotai/ovo-plugin-storage';
import type { RoutedCallFilter } from '@winsendotai/ovo-plugin-storage/outcomes';
import type { CallOutcomeReader } from './call-outcomes.ts';

/** `?transferred=1` (or `true`): a flag the calls list reads. Anything else is a validation error. */
const Flag = z
  .enum(['1', 'true'])
  .transform(() => true as const)
  .optional();

const RoutingCallQuery = z.object({
  routingPointId: z.uuid().optional(),
  segmentAgentId: z.string().min(1).max(200).optional(),
  poolId: z.uuid().optional(),
  transferred: Flag,
  human: Flag,
  fallback: Flag,
});

/** The routing filters of a calls query, or undefined when it names none. */
export function routingCallFilter(query: unknown): RoutedCallFilter | undefined {
  const found = RoutingCallQuery.parse(query);
  const filter: RoutedCallFilter = {
    ...(found.routingPointId ? { pointId: found.routingPointId } : {}),
    ...(found.segmentAgentId ? { segmentAgentId: found.segmentAgentId } : {}),
    ...(found.poolId ? { poolId: found.poolId } : {}),
    ...(found.transferred ? { transferred: true } : {}),
    ...(found.human ? { human: true } : {}),
    ...(found.fallback ? { fallback: true } : {}),
  };
  return Object.keys(filter).length ? filter : undefined;
}

const CONCURRENCY = 8;

/**
 * A page of calls that took a route matching `filter` (R4 design 6). Calls live in the control
 * store and routes in the call outcomes, which may be another database, so this is two reads: the
 * outcomes say which calls (newest outcome first, with their cursor), then the control store
 * supplies each call. A call the control store no longer has is dropped; `kind` and `status` narrow
 * the page afterwards, so a page can hold fewer calls than the limit and still have a next cursor.
 * Without an outcomes store nothing can be said: `filterUnavailable`.
 */
export async function listRoutedCalls(input: {
  store: { getCall(workspaceId: string, id: string): Promise<CallRecord | undefined> };
  outcomes: CallOutcomeReader;
  log: FastifyBaseLogger;
  workspaceId: string;
  filter: RoutedCallFilter;
  limit: number;
  cursor?: string;
  kind?: string;
  status?: string;
}) {
  const { outcomes, workspaceId } = input;
  if (!outcomes.available) return { items: [], nextCursor: null, filterUnavailable: true as const };
  const found = await (
    await outcomes.open()
  ).findRouted(workspaceId, input.filter, input.limit, input.cursor);
  const calls: (CallRecord | undefined)[] = [];
  for (let at = 0; at < found.items.length; at += CONCURRENCY)
    calls.push(
      ...(await Promise.all(
        found.items
          .slice(at, at + CONCURRENCY)
          .map((item) => input.store.getCall(workspaceId, item.callId)),
      )),
    );
  const items = calls.filter(
    (call): call is CallRecord =>
      call !== undefined &&
      (input.kind === undefined || call.kind === input.kind) &&
      (input.status === undefined || call.status === input.status),
  );
  const page: Page<CallRecord> = { items, nextCursor: found.nextCursor };
  return outcomes.attach(workspaceId, page, input.log);
}
