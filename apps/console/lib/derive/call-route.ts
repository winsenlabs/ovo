// Pure shaping for the call inspector's "Route & segments" tab: the segment timeline (offsets from
// the call's start, transfer hold gaps, disclosure pins, per-segment cost), the transfer rows and
// the person (human) summary. Everything is read from `GET /v1/calls/:id/segments`; nothing here
// fetches or invents a number the API did not record.
import type {
  CallRouteResponse,
  PayloadRecord,
  RouteEvent,
  SegmentRole,
} from '../types/call-route';

export const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
export const str = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

export const REASON_LABELS: Record<string, string> = {
  start: 'Call start',
  route: 'After routing',
  degraded: 'Degraded route',
  fallback: 'Fallback',
  transfer: 'After transfer',
  return: 'Returned after a failed transfer',
  reroute: 'Re-routed',
};

export interface TimelineSegment {
  index: number;
  role: SegmentRole;
  label: string;
  agentId: string;
  releaseId: string;
  reason: string;
  poolId: string | null;
  memberId: string | null;
  language: string | null;
  transfer: number | null;
  startMs: number;
  endMs: number;
  /** Null while unknown (the segment never reported `segment.ended`). */
  durationMs: number | null;
  /** True when the end was inferred from the next segment or the call's end. */
  open: boolean;
  ended: string | null;
  endReason: string | null;
  turns: number | null;
  costPaise: number | null;
  /** Provider quantities this segment reported on `segment.ended`, by meter key. */
  usage: Record<string, number>;
}

export interface TimelineGap {
  transfer: number;
  fromSegment: number | null;
  toSegment: number | null;
  startMs: number;
  endMs: number;
  holdMs: number;
  outcome: string | null;
}

export interface TimelinePin {
  atMs: number;
  segment: number | null;
  kinds: string[];
}

export interface RouteTimeline {
  totalMs: number;
  /** Lanes that have at least one segment, in router, agent, person order. */
  lanes: SegmentRole[];
  segments: TimelineSegment[];
  gaps: TimelineGap[];
  pins: TimelinePin[];
}

export interface CallWindow {
  createdAt?: string;
  durationMs?: number;
}

/** A segment's display name: the agent's name when known, the queue key for a person segment. */
export function segmentName(
  segment: Pick<TimelineSegment, 'role' | 'agentId'>,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  if (segment.role === 'router') return 'Router';
  if (segment.role === 'human') return `Person · ${segment.agentId.replace(/^queue:/, '')}`;
  return names.get(segment.agentId) ?? segment.agentId;
}

const eventTime = (event: RouteEvent) => Date.parse(event.at);

function endedByIndex(events: readonly RouteEvent[]): Map<number, PayloadRecord> {
  const ended = new Map<number, PayloadRecord>();
  for (const event of events) {
    const index = num(event.payload.index);
    if (event.type === 'segment.ended' && index != null) ended.set(index, event.payload);
  }
  return ended;
}

function usageOf(payload: PayloadRecord | undefined): Record<string, number> {
  const usage = payload?.usage;
  if (typeof usage !== 'object' || usage === null) return {};
  return Object.fromEntries(
    Object.entries(usage).flatMap(([key, value]) => (num(value) != null ? [[key, value]] : [])),
  ) as Record<string, number>;
}

/** Paise from a ledger decimal string; null when the ledger could not say. */
export function paise(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSegments(
  response: CallRouteResponse,
  origin: number,
  names: ReadonlyMap<string, string>,
): TimelineSegment[] {
  const ended = endedByIndex(response.events);
  const sorted = [...response.segments].sort((a, b) => a.index - b.index);
  return sorted.map((segment): TimelineSegment => {
    const closing = ended.get(segment.index);
    const started = Date.parse(segment.startedAt);
    const duration = segment.durationMs ?? num(closing?.durationMs);
    const startMs = Number.isFinite(started) ? Math.max(0, started - origin) : 0;
    return {
      index: segment.index,
      role: segment.role,
      label: segmentName(segment, names),
      agentId: segment.agentId,
      releaseId: segment.releaseId,
      reason: segment.reason,
      poolId: segment.poolId,
      memberId: segment.memberId,
      language: segment.language,
      transfer: segment.transfer,
      startMs,
      endMs: startMs + (duration ?? 0),
      durationMs: duration,
      open: duration == null,
      ended: segment.ended ?? str(closing?.ended),
      endReason: str(closing?.endReason),
      turns: num(closing?.turns),
      costPaise: paise(segment.cost?.totalPaise),
      usage: usageOf(closing),
    };
  });
}

/** Segments that never reported an end stop where the next one starts, else where the call did. */
function closeOpenSegments(segments: TimelineSegment[], callEndMs: number | null): void {
  segments.forEach((segment, position) => {
    if (!segment.open) return;
    const next = segments[position + 1];
    const stop = next ? next.startMs : callEndMs;
    segment.endMs = stop != null && stop >= segment.startMs ? stop : segment.startMs;
  });
}

function buildGaps(response: CallRouteResponse, segments: readonly TimelineSegment[]) {
  const byIndex = new Map(segments.map((segment) => [segment.index, segment]));
  const gaps: TimelineGap[] = [];
  for (const pair of response.transfers) {
    const done = pair.completed;
    const holdMs = num(done?.holdMs);
    const transfer = num(done?.transfer);
    if (!done || holdMs == null || transfer == null) continue;
    const fromIndex = num(pair.requested?.fromSegment);
    const from = fromIndex == null ? undefined : byIndex.get(fromIndex);
    const toIndex = num(done.toSegment);
    const to =
      toIndex != null
        ? byIndex.get(toIndex)
        : segments.find(
            (segment) => segment.transfer === transfer && segment.index > (fromIndex ?? -1),
          );
    let startMs: number;
    let endMs: number;
    if (to) {
      endMs = to.startMs;
      startMs =
        from && !from.open && from.endMs <= endMs ? from.endMs : Math.max(0, endMs - holdMs);
    } else {
      startMs = from?.endMs ?? 0;
      endMs = startMs + holdMs;
    }
    gaps.push({
      transfer,
      fromSegment: fromIndex,
      toSegment: to?.index ?? null,
      startMs,
      endMs,
      holdMs,
      outcome: str(done.outcome),
    });
  }
  return gaps.sort((a, b) => a.startMs - b.startMs);
}

function buildPins(events: readonly RouteEvent[], origin: number): TimelinePin[] {
  const pins: TimelinePin[] = [];
  for (const event of events) {
    if (event.type !== 'disclosure') continue;
    const at = eventTime(event);
    const kinds = Array.isArray(event.payload.kinds)
      ? event.payload.kinds.filter((kind): kind is string => typeof kind === 'string')
      : [];
    if (!Number.isFinite(at) || !kinds.length) continue;
    pins.push({
      atMs: Math.max(0, at - origin),
      segment: num(event.payload.segment) ?? event.segment ?? null,
      kinds,
    });
  }
  return pins.sort((a, b) => a.atMs - b.atMs);
}

/**
 * The call as a time axis. Offsets are milliseconds from the call's start (`window.createdAt`;
 * the first segment when the call has no clock). A segment's end is its recorded duration, else
 * where the next one starts; a transfer's hold gap runs from the sending segment's end to the
 * receiving segment's start, whatever `holdMs` says, which is what the gap is labelled with.
 */
export function buildTimeline(
  response: CallRouteResponse,
  window: CallWindow = {},
  names: ReadonlyMap<string, string> = new Map(),
): RouteTimeline {
  const callStart = Date.parse(window.createdAt ?? '');
  const firstSegment = Math.min(...response.segments.map((s) => Date.parse(s.startedAt)));
  const origin = Number.isFinite(callStart)
    ? callStart
    : Number.isFinite(firstSegment)
      ? firstSegment
      : 0;
  const callEnd = window.durationMs != null && window.durationMs > 0 ? window.durationMs : null;
  const segments = buildSegments(response, origin, names);
  closeOpenSegments(segments, callEnd);
  const gaps = buildGaps(response, segments);
  const pins = buildPins(response.events, origin);
  const farthest = Math.max(
    callEnd ?? 0,
    ...segments.map((segment) => segment.endMs),
    ...pins.map((pin) => pin.atMs),
  );
  const totalMs = Math.max(1, farthest);
  for (const gap of gaps) gap.endMs = Math.min(gap.endMs, totalMs);
  return {
    totalMs,
    lanes: (['router', 'agent', 'human'] as const).filter((role) =>
      segments.some((segment) => segment.role === role),
    ),
    segments,
    gaps,
    pins,
  };
}
