import { LOG_LEVELS, type LogFields, type LogLevel, type Logger } from '@winsendotai/ovo-contracts';
import { isSecretField, scrubCredentials } from './redaction.ts';

/** Receives one finished JSON line. The default writes warn/error to stderr, the rest to stdout. */
export type LogSink = (line: string, level: LogLevel) => void;

export interface JsonLoggerOptions {
  /** Minimum level; defaults to OVO_LOG_LEVEL, then `info`. Unknown values mean `info`. */
  level?: string;
  sink?: LogSink;
  now?: () => Date;
}

const consoleSink: LogSink = (line, level) => {
  if (level === 'warn' || level === 'error') console.error(line);
  else console.log(line);
};

const MAX_STRING = 1_000;

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase() ?? '';
  return (LOG_LEVELS as readonly string[]).includes(normalized) ? (normalized as LogLevel) : 'info';
}

/** Scrubs credentials (see `scrubCredentials`) and phone numbers, and caps the length. */
export function redactLogText(text: string): string {
  const scrubbed = scrubCredentials(text).replace(/\+\d{8,15}\b/g, '[number]');
  return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}…` : scrubbed;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactLogText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[depth-limit]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactValue(errorFields(value), depth + 1);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSecretField(key) ? '[redacted]' : redactValue(item, depth + 1),
    ]),
  );
}

/** Applies the logger's redaction to any value (exported for callers that persist log text). */
export function redactLogValue(value: unknown): unknown {
  return redactValue(value, 0);
}

/**
 * The reason, class, code and cause of a failure, as log fields. Never the stack or request
 * objects. Node's dual-stack connect failure is an AggregateError with an empty message, so its
 * inner reasons stand in for it.
 */
export function errorFields(error: unknown): {
  error: string;
  errorName?: string;
  code?: string | number;
  cause?: string;
} {
  if (!(error instanceof Error)) return { error: String(error) };
  const cause =
    error.cause === undefined
      ? undefined
      : error.cause instanceof Error
        ? error.cause.message
        : String(error.cause);
  const code = (error as { code?: unknown }).code;
  const message =
    error.message ||
    (error instanceof AggregateError
      ? error.errors.map((item) => (item instanceof Error ? item.message : String(item))).join('; ')
      : '');
  return {
    error: message,
    errorName: error.name,
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(cause ? { cause } : {}),
  };
}

/** A rejection handler that logs `event` at warn with the failure's reason, for best-effort steps. */
export function logFailure(
  logger: Logger,
  event: string,
  fields: LogFields = {},
): (error: unknown) => void {
  return (error) => logger.warn(event, { ...fields, ...errorFields(error) });
}

/** A JSON-lines logger: one object per line with ts, level, event, then context and fields. */
export function createLogger(context: LogFields = {}, options: JsonLoggerOptions = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(
    parseLogLevel(
      options.level ?? (typeof process === 'undefined' ? undefined : process.env.OVO_LOG_LEVEL),
    ),
  );
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? (() => new Date());
  const build = (base: LogFields): Logger => {
    const write = (level: LogLevel) => (event: string, fields?: LogFields) => {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      const head = { ts: now().toISOString(), level, event };
      let line: string;
      try {
        line = JSON.stringify(
          Object.assign({ ...head }, redactLogValue({ ...base, ...fields }), head),
        );
      } catch {
        // swallow-ok: the fallback line still records the event and that its fields were dropped.
        line = JSON.stringify({ ...head, logError: 'fields were not serializable' });
      }
      try {
        sink(line, level);
      } catch {
        // swallow-ok: a failing log sink must never break the call path it reports on.
      }
    };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (extra) => build({ ...base, ...extra }),
    };
  };
  return build(context);
}
