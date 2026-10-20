import { z } from 'zod';

/** ovo-sip/1: the internal protocol between the sip-gateway and the SIP carrier plugins (W11 §5). */
export const SIP_WIRE_VERSION = 1;

/** Signature headers on every internal HTTP request and media upgrade (§5.1). */
export const SIP_HEADERS = Object.freeze({
  version: 'x-ovo-sip-version',
  timestamp: 'x-ovo-sip-timestamp',
  nonce: 'x-ovo-sip-nonce',
  signature: 'x-ovo-sip-signature',
});

const E164 = /^\+[1-9]\d{6,14}$/;
const text = (max: number) => z.string().min(1).max(max);
const e164 = z.string().regex(E164);
const callId = text(256);
const isoDate = z.iso.datetime({ offset: true });
const httpUrl = (protocols: readonly string[]) =>
  text(2048).refine(
    (value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    `expected a ${protocols.join(' or ')} URL`,
  );

export const SIP_TRUNK_ID = /^[a-z0-9-]{1,40}$/;
export const SIP_CARRIER_ID = /^[a-z0-9-]{1,40}$/;
/** Forwarded header names: RFC 3261 tokens, case preserved. */
export const SIP_HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const SIP_MAX_FORWARDED_HEADERS = 16;
export const SIP_MAX_HEADER_VALUE = 256;
/** The gateway rings at most this long; the control factory clamps longer host ring timeouts. */
export const SIP_MAX_RING_TIMEOUT_SEC = 300;

export function isE164(value: string): boolean {
  return E164.test(value);
}

/** `POST inbound` (admission). `from` is 'anonymous' when the caller withholds its number. */
export const SipInboundRequestSchema = z.strictObject({
  v: z.literal(SIP_WIRE_VERSION),
  callId,
  trunkId: z.string().regex(SIP_TRUNK_ID),
  from: z.union([e164, z.literal('anonymous')]),
  to: e164,
  receivedAt: isoDate,
  headers: z
    .record(z.string().regex(SIP_HEADER_NAME), z.string().max(SIP_MAX_HEADER_VALUE))
    .refine((headers) => Object.keys(headers).length <= SIP_MAX_FORWARDED_HEADERS),
  sip: z.strictObject({
    requestUri: text(1024),
    fromUri: text(1024),
    pAssertedIdentity: text(1024).optional(),
  }),
  retry: z.number().int().min(0).max(100),
});
export type SipInboundRequest = z.infer<typeof SipInboundRequestSchema>;

/** The `CallState` values a status callback may carry ('queued' is the host's, never ours). */
export const SIP_CALL_STATES = [
  'ringing',
  'in_progress',
  'completed',
  'busy',
  'no_answer',
  'failed',
  'canceled',
] as const;
export type SipCallState = (typeof SIP_CALL_STATES)[number];

export const SipStatusRequestSchema = z.strictObject({
  v: z.literal(SIP_WIRE_VERSION),
  eventId: text(512),
  callId,
  dialRequestId: text(256).optional(),
  state: z.enum(SIP_CALL_STATES),
  occurredAt: isoDate,
  sipCode: z.number().int().min(100).max(699).optional(),
  reason: z.string().max(256).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type SipStatusRequest = z.infer<typeof SipStatusRequestSchema>;

export const SipResumeRequestSchema = z.strictObject({ v: z.literal(SIP_WIRE_VERSION), callId });
export type SipResumeRequest = z.infer<typeof SipResumeRequestSchema>;

const routeParams = z.record(text(64), z.string().max(4096));
/** `st_` + a UUID, new per media socket. */
export const SIP_STREAM_ID = /^st_[0-9a-f-]{36}$/;

/** sip-gateway → media-gateway text frames (§5.3). */
export const SipMediaFrameInSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('connected'), v: z.literal(SIP_WIRE_VERSION) }),
  z.strictObject({
    event: z.literal('start'),
    callId,
    streamId: z.string().regex(SIP_STREAM_ID),
    format: z.strictObject({ encoding: z.literal('mulaw'), sampleRate: z.literal(8000) }),
    routeParams,
  }),
  z.strictObject({
    event: z.literal('media'),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    tsMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    payload: text(16_384),
  }),
  z.strictObject({
    event: z.literal('dtmf'),
    digit: z.string().regex(/^[0-9*#A-D]$/),
    durationMs: z.number().int().min(0).max(60_000).optional(),
  }),
  z.strictObject({ event: z.literal('mark'), name: text(256) }),
  z.strictObject({ event: z.literal('cleared') }),
  z.strictObject({ event: z.literal('stop'), reason: z.string().max(64) }),
]);
export type SipMediaFrameIn = z.infer<typeof SipMediaFrameInSchema>;

/** media-gateway → sip-gateway text frames (§5.3). */
export const SipMediaFrameOutSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('media'), payload: text(64 * 1024) }),
  z.strictObject({ event: z.literal('mark'), name: text(256) }),
  z.strictObject({ event: z.literal('clear') }),
  z.strictObject({ event: z.literal('terminate') }),
]);
export type SipMediaFrameOut = z.infer<typeof SipMediaFrameOutSchema>;

export const SipCredentialsSchema = z.strictObject({
  username: text(256),
  password: text(1024),
});
export type SipCredentials = z.infer<typeof SipCredentialsSchema>;

/** `POST /v1/calls` on the control API (§5.4). */
export const SipDialRequestSchema = z.strictObject({
  requestId: callId,
  carrierId: z.string().regex(SIP_CARRIER_ID),
  bindingId: text(256),
  trunkId: z.string().regex(SIP_TRUNK_ID),
  to: e164,
  from: e164,
  media: z.strictObject({ url: httpUrl(['wss:']), routeParams }),
  callbacks: z.strictObject({
    status: httpUrl(['https:']),
    resume: httpUrl(['https:']).optional(),
  }),
  ringTimeoutSec: z.number().int().min(1).max(SIP_MAX_RING_TIMEOUT_SEC).optional(),
  maxDurationSec: z
    .number()
    .int()
    .min(1)
    .max(4 * 3600),
  credentials: SipCredentialsSchema.nullable(),
});
export type SipDialRequest = z.infer<typeof SipDialRequestSchema>;

const rejected = z.object({
  kind: z.literal('rejected'),
  reason: text(256),
  retryable: z.boolean().optional(),
});
export const SipDialResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), carrierCallId: callId, carrierRequestId: callId }),
  rejected,
]);
export type SipDialResponse = z.infer<typeof SipDialResponseSchema>;

export const SipReconcileResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({
    kind: z.literal('live'),
    carrierCallId: callId,
    state: z.enum(['queued', 'ringing', 'in_progress']),
  }),
  z.object({
    kind: z.literal('ended'),
    carrierCallId: callId,
    state: z.enum(['completed', 'busy', 'no_answer', 'failed', 'canceled']),
  }),
  z.object({ kind: z.literal('rejected'), reason: text(256) }),
]);
export type SipReconcileResponse = z.infer<typeof SipReconcileResponseSchema>;

export const SipHangupRequestSchema = z
  .strictObject({ carrierCallId: callId.optional(), carrierRequestId: callId.optional() })
  .refine((query) => query.carrierCallId || query.carrierRequestId, 'name a call');
export type SipHangupRequest = z.infer<typeof SipHangupRequestSchema>;

export const SipHangupResponseSchema = z.object({ result: z.enum(['ended', 'already_ended']) });
export type SipHangupResponse = z.infer<typeof SipHangupResponseSchema>;

/**
 * The destination of a handoff. `sip` is a bare `sip:`/`sips:` URI (no `?headers`, which would let
 * a caller of this API add headers the allow-list never saw); context rides in `headers`: `X-`
 * names only, printable-ASCII values, which the gateway percent-encodes into the Refer-To URI.
 */
export const SipHandoffTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('phone'), e164 }),
  z.strictObject({
    kind: z.literal('sip'),
    uri: text(1024).regex(
      /^sips?:[^\s<>"?&#;]+(?:;[^\s<>"?&#]+)*$/i,
      'expected a sip: or sips: URI',
    ),
    headers: z
      .record(
        z.string().regex(/^[Xx]-[A-Za-z0-9-]{1,60}$/),
        z.string().regex(/^[\x20-\x7e]{0,256}$/),
      )
      .refine((headers) => Object.keys(headers).length <= SIP_MAX_FORWARDED_HEADERS)
      .optional(),
  }),
]);
export type SipHandoffTarget = z.infer<typeof SipHandoffTargetSchema>;

export const SipHandoffRequestSchema = z.strictObject({
  carrierCallId: callId,
  requestId: callId,
  target: SipHandoffTargetSchema,
});
export type SipHandoffRequest = z.infer<typeof SipHandoffRequestSchema>;

/** `unknown`: REFER was accepted but no final sipfrag arrived (`refer_no_notify`); the leg is probably gone. */
export const SipHandoffResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('confirmed'), receiptId: text(256) }),
  z.object({ kind: z.literal('rejected'), reason: text(256), retryable: z.boolean() }),
  z.object({ kind: z.literal('unknown'), reason: text(256) }),
]);
export type SipHandoffResponse = z.infer<typeof SipHandoffResponseSchema>;

export const SipHealthResponseSchema = z.object({
  ready: z.boolean(),
  draining: z.boolean(),
  calls: z.number().int().min(0),
  trunks: z.record(z.string(), z.enum(['up', 'down', 'unknown'])),
});
export type SipHealthResponse = z.infer<typeof SipHealthResponseSchema>;
