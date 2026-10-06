import type {
  AgentCallback,
  CallbackRequest,
  CallbackWhen,
  EventSink,
} from '@winsendotai/ovo-contracts';
import { recordSessionEvent } from './outcome-events.ts';

/**
 * When a promised callback falls due (AGT-15). A delay counts from now; a local time is read in the
 * agent's timezone, today or tomorrow. A named time that has already passed, or no time at all,
 * falls due `defaultDelayMinutes` from now: the caller asked to be called, so the promise is kept
 * at the earliest sensible moment rather than dropped.
 */
export function callbackDueAt(
  when: CallbackWhen | undefined,
  now: Date,
  timezone: string,
  defaultDelayMinutes: number,
): Date {
  const fallback = new Date(now.getTime() + defaultDelayMinutes * 60_000);
  if (!when) return fallback;
  if ('inMinutes' in when) return new Date(now.getTime() + when.inMinutes * 60_000);
  const [hour, minute] = when.at.split(':').map(Number) as [number, number];
  const today = localDate(now, timezone);
  const due = zonedTime(
    { ...today, day: today.day + (when.day === 'tomorrow' ? 1 : 0), hour, minute },
    timezone,
  );
  return due.getTime() > now.getTime() ? due : fallback;
}

/** Records the promise as a `disposition` event whose `callback` field the API keeps durable. */
export function recordCallback(
  sink: EventSink | undefined,
  input: {
    turn: number;
    disposition: string;
    source: 'flow' | 'llm';
    request: CallbackRequest;
  },
): void {
  recordSessionEvent(sink, 'disposition', {
    disposition: input.disposition,
    turn: input.turn,
    ...(input.request.node ? { node: input.request.node } : {}),
    source: input.source === 'llm' ? 'llm' : 'system',
    reason: 'callback',
    callback: input.request,
  });
}

/** The request a callback node or the LLM tool makes, due by the agent's policy. */
export function callbackRequest(
  policy: AgentCallback,
  input: {
    when?: CallbackWhen;
    now: Date;
    timezone: string;
    source: 'flow' | 'llm';
    node?: string;
    reason?: string;
  },
): CallbackRequest {
  const due = callbackDueAt(input.when, input.now, input.timezone, policy.defaultDelayMinutes);
  return {
    dueAt: due.toISOString(),
    timezone: input.timezone,
    source: input.source,
    ...(input.node ? { node: input.node } : {}),
    ...(input.when ? { requested: { ...input.when } } : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 200) } : {}),
  };
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localDate(now: Date, timezone: string): WallTime {
  const parts = wallParts(now, timezone);
  return { ...parts, hour: 0, minute: 0 };
}

/** The instant a wall-clock time in `timezone` names; a day past month end rolls over. */
function zonedTime(wall: WallTime, timezone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // The zone's offset at that instant, then once more at the corrected instant for a DST edge.
  let instant = asUtc - offsetMs(new Date(asUtc), timezone);
  instant = asUtc - offsetMs(new Date(instant), timezone);
  return new Date(instant);
}

function offsetMs(at: Date, timezone: string): number {
  const wall = wallParts(at, timezone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

function wallParts(at: Date, timezone: string): WallTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}
