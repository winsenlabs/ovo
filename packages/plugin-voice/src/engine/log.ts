import { createLogger } from '@winsendotai/ovo-plugin-kit';

const logger = createLogger({ service: 'voice-engine' });

/** One JSON line per engine event, through the shared logger (OVO_LOG_LEVEL, redaction). */
export function logVoiceEvent(
  level: 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>,
): void {
  logger[level](event, fields);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
