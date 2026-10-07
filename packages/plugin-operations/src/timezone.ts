export class ScheduleTimeError extends Error {
  constructor(readonly code: 'invalid_format' | 'invalid_timezone' | 'nonexistent' | 'ambiguous') {
    super(`Scheduled local time is ${code.replace('_', ' ')}`);
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function parseLocal(value: string): LocalParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new ScheduleTimeError('invalid_format');
  const [, year, month, day, hour, minute] = match.map(Number);
  const parts = { year: year!, month: month!, day: day!, hour: hour!, minute: minute! };
  const check = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  if (
    check.getUTCFullYear() !== parts.year ||
    check.getUTCMonth() + 1 !== parts.month ||
    check.getUTCDate() !== parts.day ||
    check.getUTCHours() !== parts.hour ||
    check.getUTCMinutes() !== parts.minute
  ) {
    throw new ScheduleTimeError('invalid_format');
  }
  return parts;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formats.get(timezone);
  if (cached) return cached;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    throw new ScheduleTimeError('invalid_timezone');
  }
  if (formats.size < 500) formats.set(timezone, format);
  return format;
}

function formattedParts(format: Intl.DateTimeFormat, instant: Date): LocalParts {
  const values = Object.fromEntries(
    format
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
  };
}

function same(a: LocalParts, b: LocalParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/** Resolve an IANA local minute without silently choosing either side of a DST transition. */
export function resolveScheduledInstant(localDateTime: string, timezone: string): Date {
  const wanted = parseLocal(localDateTime);
  const format = formatter(timezone);
  const center = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  // IANA offsets are bounded by ±14 hours, so every instant showing this local minute lies within
  // 15 hours of it and is `center - offset` for an offset the zone uses in that span. Sampling the
  // offset hourly across the span finds every such offset (zones change offset at most every few
  // weeks) with 31 lookups instead of a 1,801-minute scan; each candidate is then verified.
  const offsets = new Set<number>();
  for (let hour = -15; hour <= 15; hour += 1) {
    const probe = center + hour * 3_600_000;
    const local = formattedParts(format, new Date(probe));
    offsets.add(
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) -
        Math.floor(probe / 60_000) * 60_000,
    );
  }
  const matches = [...offsets]
    .map((offset) => center - offset)
    .filter(
      (candidate) =>
        Math.abs(candidate - center) <= 900 * 60_000 &&
        same(wanted, formattedParts(format, new Date(candidate))),
    )
    .sort((a, b) => a - b);
  if (matches.length === 0) throw new ScheduleTimeError('nonexistent');
  if (matches.length > 1) throw new ScheduleTimeError('ambiguous');
  return new Date(matches[0]!);
}
