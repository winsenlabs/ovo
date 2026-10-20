/**
 * What the dispatcher's operations service needs of the human queue switches (Wave 17): its
 * sweeper (offers, deadlines, lost workers, scrubbing) is a no-op unless the service is enabled
 * here too, and an operator reads offline after `OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS` (10 to 300).
 */
export function humanQueueOperationsConfig(env: Readonly<Record<string, string | undefined>>): {
  humanQueueEnabled: boolean;
  humanQueuePresenceTtlSeconds?: number;
} {
  const seconds = Number(env.OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS);
  return {
    humanQueueEnabled: env.OVO_HUMAN_QUEUE_ENABLED === 'true',
    ...(Number.isInteger(seconds) && seconds >= 10 && seconds <= 300
      ? { humanQueuePresenceTtlSeconds: seconds }
      : {}),
  };
}
