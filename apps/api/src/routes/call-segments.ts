import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { CallOutcomeHuman, CallOutcomeSegment } from '@winsendotai/ovo-contracts';
import type { CallCostSummary, CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { CallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { viewedCall, type CallOutcomeRouteDependencies } from './call-outcomes.ts';

type SegmentCost = CallCostSummary['segments'][number];
/** A segment's totals, without the index it is keyed by. */
type Cost = Omit<SegmentCost, 'index'>;
type Payload = Record<string, unknown>;

/** At most this many session events are read for one call (20 pages of the store's maximum). */
const MAX_EVENT_PAGES = 20;

/**
 * Every `transfer.requested` in order, each with the `transfer.completed` of the same transfer
 * once an accepted request completed; a completion without a request (a host fallback) stands on
 * its own. Payloads carry ids, keys, codes and timings only (design 4.5).
 */
async function transfers(store: CallOutcomeStore, workspaceId: string, callId: string) {
  const requested: Payload[] = [];
  const completed = new Map<unknown, Payload>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const events = await store.listEvents(workspaceId, callId, 500, cursor);
    for (const event of events.items)
      if (event.type === 'transfer.requested') requested.push(event.payload);
      else if (event.type === 'transfer.completed')
        completed.set(event.payload.transfer, event.payload);
    if (!events.nextCursor) break;
    cursor = events.nextCursor;
  }
  const paired = requested.map((request) => {
    const done = request.result === 'accepted' ? completed.get(request.transfer) : undefined;
    if (done) completed.delete(request.transfer);
    return { requested: request, completed: done ?? null };
  });
  return [
    ...paired,
    ...[...completed.values()].map((done) => ({ requested: null, completed: done })),
  ];
}

/**
 * What the inspector shows for the human segment (Wave 17): which queue, how long the caller
 * waited and talked, and who answered (a user id), from the folded `human.*` events. Never a
 * caller number, destination or summary: those live in the ticket and are scrubbed with it.
 */
function humanDetails(human: CallOutcomeHuman) {
  return {
    queue: human.queueKey,
    queueId: human.queueId,
    kind: human.kind,
    ticket: human.ticket,
    waitMs: human.waitMs,
    talkMs: human.talkMs,
    operator: human.operator,
    outcome: human.outcome,
  };
}

/** Totals by segment index (`null` = call-level usage), or none when the ledger cannot say. */
async function costs(
  ledger: Pick<CostLedgerService, 'getCallCost'> | undefined,
  workspaceId: string,
  callId: string,
  log: FastifyBaseLogger,
): Promise<Map<number | null, Cost>> {
  const found = new Map<number | null, Cost>();
  if (!ledger) return found;
  try {
    for (const { index, ...cost } of (await ledger.getCallCost(workspaceId, callId)).segments)
      found.set(index, cost);
  } catch (error) {
    log.warn({ err: error }, 'call segment costs unavailable');
  }
  return found;
}

/**
 * The call inspector's route view (Wave 16, design 6): the route the call took, every segment in
 * order with its timing and cost, and every transfer request with how it ended. A direct call has
 * no segments; without the outcome store nothing is known (`available: false`).
 */
export function registerCallSegmentsRoute(
  dependencies: CallOutcomeRouteDependencies & { ledger?: Pick<CostLedgerService, 'getCallCost'> },
): void {
  const { app, outcomes } = dependencies;
  app.get('/v1/calls/:callId/segments', async (request: FastifyRequest, reply: FastifyReply) => {
    const viewed = await viewedCall(dependencies, request, reply);
    if (!viewed) return;
    const { workspaceId } = viewed;
    const callId = viewed.call.id;
    const empty = { route: null, segments: [], transfers: [], human: null, callLevelCost: null };
    if (!outcomes.available) return { callId, available: false, ...empty };
    const durable = await outcomes.open();
    const summary = await durable.get(workspaceId, callId);
    if (!summary) return { callId, available: true, ...empty };
    const [byIndex, transferList] = await Promise.all([
      costs(dependencies.ledger, workspaceId, callId, request.log),
      transfers(durable, workspaceId, callId),
    ]);
    return {
      callId,
      available: true,
      route: summary.route,
      segments: summary.segments.map((segment: CallOutcomeSegment) => ({
        ...segment,
        cost: byIndex.get(segment.index) ?? null,
        ...(segment.role === 'human' && summary.human
          ? { human: humanDetails(summary.human) }
          : {}),
      })),
      human: summary.human ? humanDetails(summary.human) : null,
      transfers: transferList,
      callLevelCost: byIndex.get(null) ?? null,
    };
  });
}
