// The route a call took, node by node, read from the `route.node` and `route.fallback` events,
// and the segment tags that split a transcript into the segments it was spoken in.
import { num, str, segmentName, REASON_LABELS, type TimelineSegment } from './call-route';
import type { CallRouteInfo, RouteEvent } from '../types/call-route';

export interface PathFallback {
  node: string | null;
  step: string;
  result: string;
  attempt: number;
  reason: string | null;
}

export interface PathStep {
  node: string;
  /** The engine whose answer chose the branch; the last engine asked when none matched. */
  engine: string | null;
  outcome: string | null;
  branch: string | null;
  confidence: number | null;
  ms: number | null;
  reason: string | null;
  /** How many engine attempts this node took. */
  attempts: number;
  decided: boolean;
  fallbacks: PathFallback[];
}

export interface RoutePath {
  steps: PathStep[];
  /** Fallbacks at nodes outside the path (a chain that ran after the tree ended). */
  loose: PathFallback[];
}

function fallbackOf(event: RouteEvent): PathFallback {
  return {
    node: str(event.payload.node),
    step: str(event.payload.step) ?? 'unknown',
    result: str(event.payload.result) ?? 'unknown',
    attempt: num(event.payload.attempt) ?? 1,
    reason: str(event.payload.reason),
  };
}

/**
 * The nodes of `route.path` (else the nodes the engines were asked about, in order), each with the
 * engine that decided it and its confidence. A node no engine matched shows the last engine asked
 * and its outcome, which is how a fallback reads in the trail.
 */
export function buildRoutePath(
  route: Pick<CallRouteInfo, 'path'> | null,
  events: readonly RouteEvent[],
): RoutePath {
  const nodeEvents = events.filter((event) => event.type === 'route.node');
  const fallbacks = events.filter((event) => event.type === 'route.fallback').map(fallbackOf);
  const asked = [...new Set(nodeEvents.flatMap((event) => str(event.payload.node) ?? []))];
  const keys = route?.path.length ? route.path : asked;
  const steps = keys.map((node): PathStep => {
    const here = nodeEvents.filter((event) => event.payload.node === node);
    const matched = here.filter((event) => event.payload.outcome === 'matched').at(-1);
    const shown = matched ?? here.at(-1);
    return {
      node,
      engine: str(shown?.payload.engine),
      outcome: str(shown?.payload.outcome),
      branch: str(shown?.payload.branch),
      confidence: num(shown?.payload.confidence),
      ms: num(shown?.payload.ms),
      reason: str(shown?.payload.reason),
      attempts: here.length,
      decided: matched != null,
      fallbacks: fallbacks.filter((fallback) => fallback.node === node),
    };
  });
  return { steps, loose: fallbacks.filter((fallback) => !keys.includes(fallback.node ?? '')) };
}

/** The routing segment a transcript entry was spoken in (R4 evidence tags it; older calls do not). */
export function segmentOf(entry: unknown): number | null {
  const tag = (entry as { segment?: unknown } | null)?.segment;
  return typeof tag === 'number' && Number.isInteger(tag) && tag >= 0 ? tag : null;
}

export interface SegmentGroup<T> {
  /** Null for a call with no segment tags at all (one group, no dividers). */
  segment: number | null;
  items: T[];
}

/**
 * Consecutive entries of the same segment, in order. An untagged entry among tagged ones belongs
 * to the segment before it; a call with no tags at all stays one group so it renders unchanged.
 */
export function groupBySegment<T>(
  items: readonly T[],
  tags: readonly (number | null)[],
): SegmentGroup<T>[] {
  if (!tags.some((tag) => tag != null)) return [{ segment: null, items: [...items] }];
  const groups: SegmentGroup<T>[] = [];
  let current: number | null = tags.find((tag) => tag != null) ?? null;
  items.forEach((item, position) => {
    current = tags[position] ?? current;
    const last = groups.at(-1);
    if (last && last.segment === current) last.items.push(item);
    else groups.push({ segment: current, items: [item] });
  });
  return groups;
}

/** "Segment 2 - Billing agent, after transfer" for a transcript divider. */
export function dividerLabel(
  index: number,
  segments: readonly Pick<TimelineSegment, 'index' | 'role' | 'agentId' | 'reason'>[],
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const segment = segments.find((candidate) => candidate.index === index);
  if (!segment) return `Segment ${index}`;
  const reason = REASON_LABELS[segment.reason]?.toLowerCase();
  return `Segment ${index} - ${segmentName(segment, names)}${reason ? `, ${reason}` : ''}`;
}
