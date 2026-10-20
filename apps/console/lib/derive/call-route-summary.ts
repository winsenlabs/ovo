// Transfers, the person segment and the KPI strip of a call's route: what the inspector's tables
// and cards read, derived from `GET /v1/calls/:id/segments`.
import { num, paise, str } from './call-route';
import type { CallRouteResponse, PayloadRecord, RouteEvent } from '../types/call-route';

export interface TransferRow {
  /** Unique within the call: the pair's position, because a refused request and the next accepted one share a number. */
  id: string;
  transfer: number;
  source: string | null;
  kind: string | null;
  key: string | null;
  confirm: string | null;
  /** The request: accepted or refused; unknown for a completion with no request. */
  result: 'accepted' | 'refused' | 'unknown';
  refusal: string | null;
  queued: boolean;
  /** How the transfer ended; null when the request was refused or never completed. */
  outcome: string | null;
  fromSegment: number | null;
  toSegment: number | null;
  prepareMs: number | null;
  queueMs: number | null;
  holdMs: number | null;
  gapMs: number | null;
  holdPolicy: string | null;
  reason: string | null;
  steps: { step: string; result: string; reason: string | null }[];
}

/** Requested vs completed, one row per transfer in call order. */
export function buildTransferRows(response: CallRouteResponse): TransferRow[] {
  const rows = response.transfers.map((pair, position): TransferRow => {
    const ask = pair.requested;
    const done = pair.completed;
    const steps = Array.isArray(done?.steps) ? done.steps : [];
    return {
      id: `t${position}`,
      transfer: num(ask?.transfer) ?? num(done?.transfer) ?? position + 1,
      source: str(ask?.source),
      kind: str(ask?.kind),
      key: str(ask?.key),
      confirm: str(ask?.confirm),
      result: ask ? (ask.result === 'refused' ? 'refused' : 'accepted') : 'unknown',
      refusal: str(ask?.refusal),
      queued: ask?.queued === true,
      outcome: str(done?.outcome),
      fromSegment: num(ask?.fromSegment),
      toSegment: num(done?.toSegment),
      prepareMs: num(done?.prepareMs),
      queueMs: num(done?.queueMs),
      holdMs: num(done?.holdMs),
      gapMs: num(done?.gapMs),
      holdPolicy: str(done?.holdPolicy),
      reason: str(done?.reason),
      steps: steps.flatMap((step: unknown) => {
        const record = step as PayloadRecord;
        return str(record?.step) && str(record?.result)
          ? [{ step: str(record.step)!, result: str(record.result)!, reason: str(record.reason) }]
          : [];
      }),
    };
  });
  return rows.sort((a, b) => a.transfer - b.transfer);
}

export interface HumanSummary {
  queue: string;
  kind: string;
  ticket: string | null;
  waitMs: number | null;
  talkMs: number | null;
  operator: string | null;
  outcome: string | null;
  callbacks: { accepted: boolean; released: boolean; outcome: string | null };
  /** Requests a queue refused before one was accepted (`queue_closed`, `no_operators`...). */
  refusals: string[];
}

function callbacksFromEvents(events: readonly RouteEvent[]) {
  const callbacks = { accepted: false, released: false, outcome: null as string | null };
  for (const event of events) {
    if (event.type !== 'human.state') continue;
    const code = str(event.payload.callback);
    if (code === 'accepted') callbacks.accepted = true;
    else if (code === 'released') callbacks.released = true;
    else if (code === 'outcome') callbacks.outcome = str(event.payload.code) ?? 'reported';
  }
  return callbacks;
}

/** The person segment's card; null for a call that never asked for a person. */
export function buildHuman(response: CallRouteResponse): HumanSummary | null {
  const human = response.human ?? response.segments.find((segment) => segment.human)?.human ?? null;
  const refusals = response.events
    .filter((event) => event.type === 'human.requested' && event.payload.result === 'refused')
    .map((event) => str(event.payload.refusal) ?? 'refused');
  if (!human) return null;
  return {
    queue: human.queue,
    kind: human.kind,
    ticket: human.ticket ?? null,
    waitMs: human.waitMs,
    talkMs: human.talkMs,
    operator: human.operator,
    outcome: human.outcome,
    callbacks: human.callbacks ?? callbacksFromEvents(response.events),
    refusals,
  };
}

export interface RouteKpis {
  target: string | null;
  degraded: string | null;
  segments: number;
  transfersRequested: number;
  transfersRefused: number;
  transfersConnected: number;
  holdTotalMs: number | null;
  waitMs: number | null;
  talkMs: number | null;
}

export function buildKpis(response: CallRouteResponse): RouteKpis {
  const rows = buildTransferRows(response);
  const holds = rows.flatMap((row) => (row.holdMs == null ? [] : [row.holdMs]));
  const human = buildHuman(response);
  return {
    target: response.route?.target ?? null,
    degraded: response.route?.degraded ?? null,
    segments: response.segments.length,
    transfersRequested: rows.length,
    transfersRefused: rows.filter((row) => row.result === 'refused').length,
    transfersConnected: rows.filter((row) => row.outcome === 'connected').length,
    holdTotalMs: holds.length ? holds.reduce((sum, ms) => sum + ms, 0) : null,
    waitMs: human?.waitMs ?? null,
    talkMs: human?.talkMs ?? null,
  };
}

export interface CostRollup {
  currency: string;
  /** Null when the ledger priced nothing for this call. */
  totalPaise: number | null;
  segmentsPaise: number;
  callLevelPaise: number;
}

/** Segment totals plus call-level usage (the router's STT before any segment, for instance). */
export function costRollup(response: CallRouteResponse): CostRollup {
  const segmentCosts = response.segments.map((segment) => paise(segment.cost?.totalPaise));
  const callLevel = paise(response.callLevelCost?.totalPaise);
  const priced = [...segmentCosts, callLevel].some((value) => value != null);
  const segmentsPaise = segmentCosts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    currency:
      response.callLevelCost?.currency ??
      response.segments.find((s) => s.cost)?.cost?.currency ??
      'INR',
    totalPaise: priced ? segmentsPaise + (callLevel ?? 0) : null,
    segmentsPaise,
    callLevelPaise: callLevel ?? 0,
  };
}

/** The tab shows for a routed call, and for an installation that cannot say (not stored). */
export function hasRouteData(response: CallRouteResponse): boolean {
  return response.route != null || response.segments.length > 0;
}

/** The events that belong to one segment: tagged with it, indexed by it, or moving into or out of it. */
export function eventsForSegment(events: readonly RouteEvent[], index: number): RouteEvent[] {
  return events.filter((event) => {
    const { payload } = event;
    return (
      event.segment === index ||
      payload.index === index ||
      payload.segment === index ||
      payload.fromSegment === index ||
      payload.toSegment === index
    );
  });
}

export const TARGET_LABELS: Record<string, string> = {
  agent: 'Agent',
  human: 'Person',
  end: 'Ended',
  callback: 'Callback',
};
