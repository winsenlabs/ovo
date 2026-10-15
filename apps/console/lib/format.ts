// Formatting primitives (design brief §1.3 "Humanise every value"). Every new screen should read
// a value through one of these, never through `.toLocaleString()` with the browser's default
// locale or a bare template string of a minor-unit amount.
// Every screen is served from a single installation's clock (today the GCP VM, UTC), not the
// operator's own device, so an absolute timestamp must be pinned to one zone rather than left to
// drift with whatever the server happened to run in — the dashboard showed "12:00 am" for a
// 05:30 IST call. Change this one constant (or make it .env-configurable) if the installation's
// operating timezone is ever not India.
const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

export function formatPaise(value?: string | null): string {
  if (value == null) return 'unpriced';
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return `${value} paise`;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(
    number / 100,
  );
}

export function formatTime(value?: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}

function parseDate(value?: string | number | Date | null): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Locale-correct absolute timestamp, en-IN, for screens and tooltips (fixes the US-date defect). */
export function formatDateTime(
  value?: string | number | Date | null,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = parseDate(value);
  if (!date) return 'Unknown';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: DEFAULT_TIME_ZONE,
    ...options,
  }).format(date);
}

export function formatDate(value?: string | number | Date | null): string {
  const date = parseDate(value);
  if (!date) return 'Unknown';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeZone: DEFAULT_TIME_ZONE,
  }).format(date);
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];
const RELATIVE = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });

/** "4 minutes ago" / "in 2 days", always paired with an absolute en-IN tooltip by callers. */
export function formatRelativeTime(
  value?: string | number | Date | null,
  now: Date = new Date(),
): string {
  const date = parseDate(value);
  if (!date) return 'Unknown';
  const seconds = (date.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 5) return 'Just now';
  for (const [unit, size] of RELATIVE_UNITS)
    if (abs >= size || unit === 'second') return RELATIVE.format(Math.round(seconds / size), unit);
  return RELATIVE.format(Math.round(seconds), 'second');
}

/** `228520` -> "3m 48s"; sub-second precision collapses to whole seconds above 1s. */
export function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return 'Unknown';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const CURRENCY_DIGITS: Record<string, number> = { INR: 2, USD: 2, JPY: 0 };

/** Minor units (paise, cents) in a given currency -> a localised amount, en-IN grouping for INR. */
export function formatMoney(minorUnits?: number | string | null, currency: string = 'INR'): string {
  if (minorUnits == null) return 'Unpriced';
  const number = Number(minorUnits);
  if (!Number.isFinite(number)) return 'Unpriced';
  const digits = CURRENCY_DIGITS[currency] ?? 2;
  const value = number / 10 ** digits;
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

/** `0.1` -> "10%"; keeps one decimal only when the value needs it (`0.943` -> "94.3%"). */
export function formatPercent(value?: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return 'Unknown';
  const rounded = Math.round(value * 100 * 10 ** digits) / 10 ** digits;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(digits)}%`;
}

/** E.164 `+919820000000` -> "+91 98200 00000"; falls back to the raw value for anything else. */
export function formatPhoneNumber(value?: string | null): string {
  if (!value) return 'Unknown';
  const match = /^\+91(\d{10})$/.exec(value);
  if (match) return `+91 ${match[1].slice(0, 5)} ${match[1].slice(5)}`;
  const generic = /^(\+\d{1,3})(\d{4,})$/.exec(value);
  return generic ? `${generic[1]} ${generic[2]}` : value;
}

/** `cmp_8f3a2b9c1d0e` -> "cmp_8f3a…d0e"; the full id stays available via title/copy. */
export function shortenId(id: string, head = 8, tail = 3): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** `uncached_input_tokens` -> "input tokens"; small lookup for cost-line units, extend as needed. */
const UNIT_LABELS: Record<string, string> = {
  uncached_input_tokens: 'input tokens',
  cached_input_tokens: 'cached input tokens',
  output_tokens: 'output tokens',
  audio_seconds: 's audio',
  characters: 'characters',
  minutes: 'minutes',
};

export function formatQuantity(quantity: number, unit: string): string {
  const label = UNIT_LABELS[unit] ?? unit.replace(/_/g, ' ');
  const count = new Intl.NumberFormat('en-IN').format(quantity);
  return unit === 'audio_seconds' ? `${count}${label}` : `${count} ${label}`;
}
