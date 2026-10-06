import { z } from 'zod';
import { resolveScheduledInstant, ScheduleTimeError } from './timezone.ts';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM, 00:00 to 23:59');

/**
 * When outbound calls may be placed, in local time (collections compliance). `days` are ISO
 * weekdays, 1 = Monday to 7 = Sunday; absent means every day. `end` is exclusive and must follow
 * `start` on the same day. `timezone` is optional on input: the campaign's or the agent's applies.
 */
export const callingWindowSchema = z
  .object({
    start: clock,
    end: clock,
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'days must be unique')
      .optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((window) => window.start < window.end, {
    message: 'end must be after start on the same day',
    path: ['end'],
  });
export type CallingWindowInput = z.infer<typeof callingWindowSchema>;

/** A window with its timezone fixed, as a campaign stores it. */
export interface CallingWindow {
  start: string;
  end: string;
  days?: number[];
  timezone: string;
}

export type CallingWindowState = { open: true } | { open: false; nextOpenAt: Date };

/** Fixes the timezone a window is judged in, and checks that it is a real IANA zone. */
export function resolveCallingWindow(window: CallingWindowInput, timezone: string): CallingWindow {
  const resolved = { ...window, timezone: window.timezone ?? timezone };
  localParts(new Date(0), resolved.timezone);
  return {
    start: resolved.start,
    end: resolved.end,
    ...(resolved.days ? { days: [...resolved.days].sort((a, b) => a - b) } : {}),
    timezone: resolved.timezone,
  };
}

/**
 * Whether `now` falls inside the window, and if not, the next instant it opens. A start minute
 * that does not exist on a DST-change day opens at the first minute after it that does.
 */
export function callingWindowState(window: CallingWindow, now = new Date()): CallingWindowState {
  const local = localParts(now, window.timezone);
  const minute = `${pad(local.hour)}:${pad(local.minute)}`;
  const allowed = (weekday: number) => !window.days || window.days.includes(weekday);
  if (allowed(local.weekday) && minute >= window.start && minute < window.end)
    return { open: true };
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (!allowed(weekday) || (offset === 0 && minute >= window.start)) continue;
    const date = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    const opens = openingInstant(date, window);
    if (opens && opens.getTime() > now.getTime()) return { open: false, nextOpenAt: opens };
  }
  throw new Error('Calling window never opens');
}

function openingInstant(date: string, window: CallingWindow): Date | undefined {
  const [hour, minute] = window.start.split(':').map(Number) as [number, number];
  // Scan forward a minute at a time past a spring-forward gap; it is never longer than two hours.
  for (let step = 0; step <= 120; step += 1) {
    const total = hour * 60 + minute + step;
    const candidate = `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
    if (candidate >= window.end) return undefined;
    try {
      return resolveScheduledInstant(`${date}T${candidate}`, window.timezone);
    } catch (error) {
      if (!(error instanceof ScheduleTimeError)) throw error;
      // An ambiguous fall-back minute opens at its first occurrence.
      if (error.code === 'ambiguous')
        return firstOccurrence(`${date}T${candidate}`, window.timezone);
      if (error.code !== 'nonexistent') throw error;
    }
  }
  return undefined;
}

function firstOccurrence(localDateTime: string, timezone: string): Date {
  const [date, time] = localDateTime.split('T') as [string, string];
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const center = Date.UTC(year, month - 1, day, hour, minute);
  for (let delta = -900; delta <= 900; delta += 1) {
    const instant = new Date(center + delta * 60_000);
    const local = localParts(instant, timezone);
    if (
      local.year === year &&
      local.month === month &&
      local.day === day &&
      local.hour === hour &&
      local.minute === minute
    )
      return instant;
  }
  throw new ScheduleTimeError('nonexistent');
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localParts(instant: Date, timezone: string): LocalParts {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    throw new ScheduleTimeError('invalid_timezone');
  }
  const parts = Object.fromEntries(
    format
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday!]!,
  };
}

const pad = (value: number) => String(value).padStart(2, '0');
