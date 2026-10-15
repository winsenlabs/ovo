import { z } from 'zod';

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** A window may end at `24:00`, the end of the day (R2; `23:59` would close the last minute). */
const EndClock = z.union([Clock, z.literal('24:00')]);
export const ROUTE_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const RouteWindow = z
  .object({ start: Clock, end: EndClock })
  .strict()
  .refine(
    (w) => w.start < w.end,
    'A window ends after it starts; split an overnight window in two',
  );
export type RouteWindow = z.infer<typeof RouteWindow>;

function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opening hours of a pool member or a `time` rule. A day missing from `weekly` is closed; a member
 * without `hours` is always open.
 */
export const RoutingHours = z
  .object({
    /** IANA zone, checked with Intl.DateTimeFormat. */
    timezone: z.string().min(1).max(100).refine(knownTimeZone, 'Unknown IANA time zone'),
    weekly: z.partialRecord(z.enum(ROUTE_WEEKDAYS), z.array(RouteWindow).max(4)),
    /** Local dates the member or rule is closed all day. */
    closed: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .max(366)
      .default([]),
  })
  .strict();
export type RoutingHours = z.infer<typeof RoutingHours>;
