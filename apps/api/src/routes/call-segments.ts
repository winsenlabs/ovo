import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import {
  readSessionEvent,
  type CallOutcomeHuman,
  type CallOutcomeSegment,
} from '@winsendotai/ovo-contracts';
import type { CallCostSummary, CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { CallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { viewedCall, type CallOutcomeRouteDependencies } from './call-outcomes.ts';

type SegmentCost = CallCostSummary['segments'][number];
/** A segment's totals, without the index it is keyed by. */
type Cost = Omit<SegmentCost, 'index'>;
type Payload = Record<string, unknown>;

/** At most this many session events are read for one call (20 pages of the store's maximum). */
const MAX_EVENT_PAGES = 20;

/** The route, segment, transfer, human and disclosure events the inspector's timeline draws. */
const TIMELINE_EVENTS = new Set([
  'route.node',
  'route.fallback',
  'route.decision',
  'route.segment',
  'segment.ended',
  'transfer.requested',
  'transfer.completed',
  'disclosure',
  'human.requested',
  'human.state',
  'human.webhook',
  'human.completed',
]);
/** At most this many timeline events are returned (R4); the response says when there were more. */
const MAX_TIMELINE_EVENTS = 400;

interface TimelineEvent {
  sequence: number;
  at: string;
  type: string;
  /** The routing segment the worker stamped on the event, when it did. */
  segment?: number;
  payload: Payload;
}

/** A router `disposition` (an end or a callback), unlike the flow dispositions of other agents. */
const routerDisposition = (type: string, payload: Payload) =>
  type === 'disposition' && payload.source === 'system';

/**
 * Every `transfer.requested` in order, each with the `transfer.completed` of the same transfer
 * once an accepted request completed; a completion without a request (a host fallback) stands on
 * its own. Payloads carry ids, keys, codes and timings only (design 4.5). The same pass collects
 * the timeline events (R4): the allowlisted types, each read again with `readSessionEvent` and
 * dropped if it does not parse, capped at 400.
 */
async function readEvents(store: CallOutcomeStore, workspaceId: string, callId: string) {
  const requested: Payload[] = [];
  const completed = new Map<unknown, Payload>();
  const timeline: TimelineEvent[] = [];
  let truncated = false;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const events = await store.listEvents(workspaceId, callId, 500, cursor);
    for (const event of events.items) {
      if (event.type === 'transfer.requested') requested.push(event.payload);
      else if (event.type === 'transfer.completed')
        completed.set(event.payload.transfer, event.payload);
      if (!TIMELINE_EVENTS.has(event.type) && !routerDisposition(event.type, event.payload))
        continue;
      if (timeline.length >= MAX_TIMELINE_EVENTS) {
        truncated = true;
        continue;
      }
      try {
        const { payload } = readSessionEvent(event.type, event.payload);
        timeline.push({
          sequence: event.sequence,
          at: event.at,
          type: event.type,
          ...(typeof payload.segment === 'number' ? { segment: payload.segment } : {}),
          payload: payload as Payload,
        });
      } catch {
        // swallow-ok: an event that no longer parses is left out of the timeline, not the call.
      }
    }
    if (!events.nextCursor) break;
    cursor = events.nextCursor;
  }
  const paired = requested.map((request) => {
    const done = request.result === 'accepted' ? completed.get(request.transfer) : undefined;
    if (done) completed.delete(request.transfer);
    return { requested: request, completed: done ?? null };
  });
  return {
    transfers: [
      ...paired,
      ...[...completed.values()].map((done) => ({ requested: null, completed: done })),
    ],
    events: timeline,
    eventsTruncated: truncated,
  };
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
    const empty = {
      route: null,
      segments: [],
      transfers: [],
      human: null,
      callLevelCost: null,
      events: [],
      eventsTruncated: false,
    };
    if (!outcomes.available) return { callId, available: false, ...empty };
    const durable = await outcomes.open();
    const summary = await durable.get(workspaceId, callId);
    if (!summary) return { callId, available: true, ...empty };
    const [byIndex, read] = await Promise.all([
      costs(dependencies.ledger, workspaceId, callId, request.log),
      readEvents(durable, workspaceId, callId),
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
      transfers: read.transfers,
      callLevelCost: byIndex.get(null) ?? null,
      events: read.events,
      eventsTruncated: read.eventsTruncated,
    };
  });
}
