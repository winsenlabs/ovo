/** One JSON line per engine event; the shared logger replaces this once it lands. */
export function logVoiceEvent(
  level: 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>,
): void {
  console.error(JSON.stringify({ service: 'voice-engine', event, level, ...fields }));
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
