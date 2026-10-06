/** Severity order: a logger at `info` drops `debug` and writes the rest. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Structured fields; ids (sessionId, callId, jobId, carrierCallId, streamId, generation) by name. */
export type LogFields = Readonly<Record<string, unknown>>;

/** The process log port. Implementations redact secrets before a line leaves the process. */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger whose every line carries `context` in addition to its parent's. */
  child(context: LogFields): Logger;
}
