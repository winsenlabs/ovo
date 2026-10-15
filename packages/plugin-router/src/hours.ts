import type { RoutingHours } from '@winsendotai/ovo-contracts';

type Weekday = keyof RoutingHours['weekly'];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let found = formatters.get(timezone);
  if (!found) {
    // Throws RangeError for a zone this runtime does not know; callers decide what that means.
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timezone, found);
  }
  return found;
}

/** The wall clock in `timezone` at `epochMs`: weekday, local date and minutes since midnight. */
export function localTime(
  timezone: string,
  epochMs: number,
): { weekday: Weekday; date: string; minutes: number } {
  const parts: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(new Date(epochMs)))
    parts[part.type] = part.value;
  return {
    weekday: parts.weekday!.toLowerCase().slice(0, 3) as Weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/**
 * Whether `hours` are open at `epochMs`, read on the wall clock of their IANA zone, so a DST change
 * moves the instant a window opens and never the local time. A window includes its start minute
 * and excludes its end minute; a day missing from `weekly` is closed, and a `closed` local date is
 * closed all day. Throws RangeError for an unknown zone.
 */
export function isOpen(hours: RoutingHours, epochMs: number): boolean {
  const local = localTime(hours.timezone, epochMs);
  if (hours.closed.includes(local.date)) return false;
  return (hours.weekly[local.weekday] ?? []).some(
    (window) => local.minutes >= minutesOf(window.start) && local.minutes < minutesOf(window.end),
  );
}
