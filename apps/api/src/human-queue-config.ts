type Environment = Readonly<Record<string, string | undefined>>;

/** Operator join tokens live this long unless `OVO_LIVEKIT_TOKEN_TTL_SECONDS` says otherwise. */
export const DEFAULT_ROOM_TOKEN_TTL_SECONDS = 120;
/** An operator heartbeat older than this reads OFFLINE (`OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS`). */
export const DEFAULT_PRESENCE_TTL_SECONDS = 30;
const MIN_ROOM_TOKEN_TTL_SECONDS = 30;
const MAX_ROOM_TOKEN_TTL_SECONDS = 600;

/**
 * The human queue flags (Wave 17, design 10.1), all off unless set to exactly `true`. With the
 * master flag off every `/v1/human-queues|desk|human-queue/*` route but `status` answers 404
 * `human_queue_disabled` and `human` routing steps are skipped by the worker; the webhook flag
 * lets an external queue post (and `test-webhook` run); the token TTL bounds an operator's grant.
 */
export function humanQueueFlagsFromEnv(environment: Environment): {
  humanQueueEnabled: boolean;
  humanQueueWebhookEnabled: boolean;
  roomTokenTtlSeconds: number;
  humanQueuePresenceTtlSeconds: number;
  humanQueueCallbackBaseUrl: string | undefined;
} {
  const configured = environment.OVO_LIVEKIT_TOKEN_TTL_SECONDS?.trim();
  const ttl = configured === undefined || configured === '' ? NaN : Number(configured);
  const presence = Number(environment.OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS);
  return {
    humanQueueCallbackBaseUrl:
      environment.OVO_HUMAN_QUEUE_CALLBACK_BASE_URL?.trim() ||
      environment.OVO_MEDIA_PUBLIC_BASE_URL?.trim() ||
      undefined,
    humanQueuePresenceTtlSeconds:
      Number.isInteger(presence) && presence >= 10 && presence <= 300
        ? presence
        : DEFAULT_PRESENCE_TTL_SECONDS,
    humanQueueEnabled: environment.OVO_HUMAN_QUEUE_ENABLED === 'true',
    humanQueueWebhookEnabled: environment.OVO_HUMAN_QUEUE_WEBHOOK_ENABLED === 'true',
    roomTokenTtlSeconds:
      Number.isInteger(ttl) &&
      ttl >= MIN_ROOM_TOKEN_TTL_SECONDS &&
      ttl <= MAX_ROOM_TOKEN_TTL_SECONDS
        ? ttl
        : DEFAULT_ROOM_TOKEN_TTL_SECONDS,
  };
}
