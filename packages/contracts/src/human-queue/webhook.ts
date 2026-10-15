import { z } from 'zod';

/**
 * Wave 17 (R3) third-party queue: the outbound webhook a queue posts when a call needs a person.
 * Everything here is data; the worker sends it through the pinned HTTP client and the API previews
 * and tests it. A mapping reads a fixed context namespace (`mapping.ts`), never the call itself.
 */

/** The fixed context namespaces a mapping may read; each is gated by the queue's context policy. */
export const CONTEXT_PATHS = {
  call: ['id', 'direction', 'startedAt'],
  caller: ['number', 'calledNumber'],
  route: ['path', 'language', 'intent', 'context'],
  handover: ['summary', 'reason', 'transcript'],
  variables: ['*'],
  queue: ['key', 'id', 'name'],
  ticket: [
    'id',
    'idempotencyKey',
    'priority',
    'callbackUrl',
    'contextUrl',
    'transcriptUrl',
    'expiresAt',
    /** `handoff`, or `cancelled` on the best-effort cancel post. */
    'event',
  ],
  time: ['now'],
} as const;
export const ContextPath = z
  .string()
  .regex(/^(call|caller|route|handover|variables|queue|ticket|time)(\.[A-Za-z0-9_-]{1,64}){0,3}$/);

const Scalar = z.union([z.string().max(1_000), z.number(), z.boolean(), z.null()]);
/** `{ "$from": "caller.number", "default": "", "maxChars": 32, "as": "string" }` */
export const MappingRef = z
  .object({
    $from: ContextPath,
    default: Scalar.optional(),
    maxChars: z.number().int().min(1).max(4_000).optional(),
    as: z.enum(['string', 'number', 'boolean', 'json']).optional(),
  })
  .strict();
export type MappingRef = z.infer<typeof MappingRef>;
/** `{ "$template": "Call from {{caller.number}} about {{route.intent}}" }`; unknown paths render empty. */
export const MappingTemplate = z
  .object({
    $template: z.string().min(1).max(1_000),
    maxChars: z.number().int().min(1).max(4_000).optional(),
  })
  .strict();
export type MappingTemplate = z.infer<typeof MappingTemplate>;
export type MappingValue =
  | string
  | number
  | boolean
  | null
  | MappingRef
  | MappingTemplate
  | MappingValue[]
  | { [key: string]: MappingValue };

/** Plain object keys may not start with `$` (reserved). */
const PlainKey = z.string().regex(/^[^$\s][^\s]{0,63}$/);
export const MappingValue: z.ZodType<MappingValue> = z.lazy(() =>
  z.union([
    Scalar,
    MappingRef,
    MappingTemplate,
    z.array(MappingValue).max(50),
    z.record(PlainKey, MappingValue),
  ]),
);
export const FieldMapping = z.record(PlainKey, MappingValue);
export type FieldMapping = z.infer<typeof FieldMapping>;
/** At most this deep and this many nodes (`mappingIssues`). */
export const MAPPING_LIMITS = Object.freeze({ depth: 6, nodes: 200, bodyBytes: 64 * 1024 });

const HeaderName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);
/** Never settable: framing, auth (own field) and OVO's own. Checked case-insensitively; so is any `x-ovo-*`. */
export const RESERVED_WEBHOOK_HEADERS = [
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'authorization',
  'cookie',
  'idempotency-key',
  'user-agent',
] as const;
const Pointer = z.string().regex(/^\/[A-Za-z0-9_~\-./]{0,198}$/); // RFC 6901

export const WebhookAuth = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('bearer'), credentialId: z.string().min(1).max(200) }).strict(),
  z
    .object({
      kind: z.literal('header'),
      name: HeaderName,
      credentialId: z.string().min(1).max(200),
    })
    .strict(),
]);
export type WebhookAuth = z.infer<typeof WebhookAuth>;

export const RetryPolicy = z
  .object({
    attempts: z.number().int().min(1).max(5).default(3),
    /** Doubles per attempt, +-20% jitter. */
    baseMs: z.number().int().min(100).max(5_000).default(500),
    maxMs: z.number().int().min(100).max(10_000).default(5_000),
    /** All attempts; also bounded by the hold. */
    deadlineMs: z.number().int().min(1_000).max(60_000).default(15_000),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicy>;
const DEFAULT_RETRY = { attempts: 3, baseMs: 500, maxMs: 5_000, deadlineMs: 15_000 };

/** How to read the third party's answer. Absent paths: the canonical `ovo.human-queue-response/1` body. */
export const ResponseMapping = z
  .object({
    statusPath: Pointer.optional(),
    acceptedValues: z.array(z.string().max(60)).max(10).default(['accepted', 'ok', 'connected']),
    queuedValues: z.array(z.string().max(60)).max(10).default(['queued', 'pending', 'waiting']),
    rejectedValues: z
      .array(z.string().max(60))
      .max(10)
      .default(['rejected', 'denied', 'closed', 'unavailable']),
    ticketRefPath: Pointer.optional(),
    destinationE164Path: Pointer.optional(),
    destinationSipUriPath: Pointer.optional(),
    /** An object of header name to value. */
    destinationHeadersPath: Pointer.optional(),
  })
  .strict();
export type ResponseMapping = z.infer<typeof ResponseMapping>;
const DEFAULT_RESPONSE = {
  acceptedValues: ['accepted', 'ok', 'connected'],
  queuedValues: ['queued', 'pending', 'waiting'],
  rejectedValues: ['rejected', 'denied', 'closed', 'unavailable'],
};

export const WebhookSpec = z
  .object({
    /** https, public host, no credentials or fragment: publish re-checks (`parseApprovedEndpoint`). */
    url: z.url().max(2_048),
    method: z.enum(['POST', 'PUT']).default('POST'),
    /** `form`: the mapped body must be flat. */
    format: z.enum(['json', 'form']).default('json'),
    /** The HMAC signing secret. A credential allowed for the router agent. */
    credentialId: z.string().min(1).max(200),
    auth: WebhookAuth.default({ kind: 'none' }),
    /** Static values only. */
    headers: z.record(HeaderName, z.string().max(256)).default({}),
    /** Absent: the canonical `ovo.human-queue/1` body. */
    body: FieldMapping.optional(),
    /** Per attempt. */
    timeoutMs: z.number().int().min(200).max(10_000).default(3_000),
    retry: RetryPolicy.default(DEFAULT_RETRY),
    response: ResponseMapping.default(DEFAULT_RESPONSE),
    /** Tell the third party when OVO gives up (hold timeout, caller hung up): one best-effort `cancelled` post. */
    cancel: z.boolean().default(true),
  })
  .strict();
export type WebhookSpec = z.infer<typeof WebhookSpec>;

/** Toll-fraud guard: a third party's answer can only reach what the queue allows. Mandatory. */
export const DestinationPolicy = z
  .object({
    allowE164Prefixes: z
      .array(z.string().regex(/^\+[1-9][0-9]{0,6}$/))
      .min(1)
      .max(50),
    /** Exact host (`acd.example.com`) or suffix (`.example.com`); the scheme must be `sips:` unless `allowInsecureSip`. */
    allowSipHosts: z
      .array(z.string().regex(/^\.?[a-z0-9][a-z0-9.-]{0,252}$/))
      .max(50)
      .default([]),
    allowInsecureSip: z.boolean().default(false),
    /** Header names the answer may set on the SIP transfer (`X-` names only, at most 16). */
    allowedHeaders: z
      .array(z.string().regex(/^X-[A-Za-z0-9-]{1,40}$/))
      .max(16)
      .default([]),
  })
  .strict();
export type DestinationPolicy = z.infer<typeof DestinationPolicy>;
