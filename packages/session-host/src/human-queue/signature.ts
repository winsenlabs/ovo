import { createHmac, timingSafeEqual } from 'node:crypto';

/** Callbacks older or newer than this are refused (human queue design 6.3, 11). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * `v1=<hex HMAC-SHA256(secret, "<timestamp>.<id>.<body>")>`: the one signature scheme of OVO's
 * outbound webhooks. `id` is the request id of a request OVO sends (a routing decision, a human
 * queue handoff) and the event id of a callback the third party sends back.
 */
export function webhookSignature(
  secret: string,
  timestamp: string,
  id: string,
  body: string,
): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${id}.${body}`).digest('hex')}`;
}

export type SignatureCheck = 'ok' | 'malformed' | 'stale' | 'mismatch';

/**
 * Checks a signed message: a well-formed `v1=` signature, a timestamp within the tolerance of
 * `now`, and a constant-time match. Never throws; the verdict is a code a caller can log.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string | undefined;
  id: string | undefined;
  body: string;
  signature: string | undefined;
  /** Epoch ms. */
  now: number;
  toleranceSeconds?: number;
}): SignatureCheck {
  const { timestamp, id, signature } = input;
  if (!timestamp || !id || !signature || !/^\d{1,12}$/.test(timestamp)) return 'malformed';
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) return 'malformed';
  const skew = Math.abs(input.now / 1000 - Number(timestamp));
  if (skew > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return 'stale';
  const expected = Buffer.from(webhookSignature(input.secret, timestamp, id, input.body));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? 'ok' : 'mismatch';
}
