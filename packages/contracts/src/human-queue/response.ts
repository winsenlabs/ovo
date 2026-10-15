import type { DestinationPolicy, WebhookSpec } from './webhook.ts';

/**
 * Reading a third party's answer and checking where it would send the caller. Pure, so the worker,
 * the API's callback endpoint and `test-webhook` agree byte for byte.
 */
export interface WebhookDestination {
  e164?: string;
  sipUri?: string;
  headers?: Record<string, string>;
}
export type WebhookAnswer =
  | { kind: 'accepted'; destination: WebhookDestination; ticketRef?: string }
  | { kind: 'queued'; ticketRef?: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'invalid'; reason: 'status' | 'destination' | 'json' };

/** An RFC 6901 pointer into a parsed body; `undefined` when any step is missing. */
export function readPointer(body: unknown, pointer: string): unknown {
  let at: unknown = body;
  for (const raw of pointer.slice(1).split('/')) {
    const step = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (at === null || typeof at !== 'object') return undefined;
    if (Array.isArray(at)) {
      if (!/^(0|[1-9][0-9]*)$/.test(step)) return undefined;
      at = at[Number(step)];
    } else {
      if (!Object.hasOwn(at, step)) return undefined;
      at = (at as Record<string, unknown>)[step];
    }
  }
  return at;
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : undefined;

function headersOf(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    const v = typeof raw === 'number' ? String(raw) : raw;
    if (typeof v === 'string') headers[name] = v;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Reads the answer to a handoff post. A mapped answer uses the spec's JSON pointers; an unmapped
 * one is the canonical `ovo.human-queue-response/1`. Anything but a 2xx JSON object with a known
 * status is `invalid`; an `accepted` answer without exactly one destination is `invalid` too.
 */
export function parseWebhookResponse(
  spec: WebhookSpec,
  status: number,
  body: unknown,
): WebhookAnswer {
  if (status < 200 || status > 299) return { kind: 'invalid', reason: 'status' };
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { kind: 'invalid', reason: 'json' };
  const map = spec.response;
  const raw = map.statusPath
    ? readPointer(body, map.statusPath)
    : (body as { status?: unknown }).status;
  const word =
    typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
      ? String(raw).trim().toLowerCase()
      : '';
  const among = (values: readonly string[]) => values.some((v) => v.toLowerCase() === word);
  const ticketRef = text(
    map.ticketRefPath
      ? readPointer(body, map.ticketRefPath)
      : (body as { ticketRef?: unknown }).ticketRef,
    200,
  );
  const withRef = ticketRef === undefined ? {} : { ticketRef };
  if (word === '') return { kind: 'invalid', reason: 'status' };
  if (among(map.rejectedValues)) {
    const reason = text((body as { reason?: unknown }).reason, 200);
    return { kind: 'rejected', reason: reason ?? word };
  }
  if (among(map.queuedValues)) return { kind: 'queued', ...withRef };
  if (!among(map.acceptedValues)) return { kind: 'invalid', reason: 'status' };
  const mapped = map.destinationE164Path || map.destinationSipUriPath || map.destinationHeadersPath;
  const canonical = (body as { destination?: Record<string, unknown> }).destination;
  const e164 = text(
    mapped
      ? map.destinationE164Path && readPointer(body, map.destinationE164Path)
      : canonical?.e164,
    64,
  );
  const sipUri = text(
    mapped
      ? map.destinationSipUriPath && readPointer(body, map.destinationSipUriPath)
      : canonical?.sipUri,
    512,
  );
  if ((e164 === undefined) === (sipUri === undefined))
    return { kind: 'invalid', reason: 'destination' };
  const headers = headersOf(
    mapped
      ? map.destinationHeadersPath && readPointer(body, map.destinationHeadersPath)
      : canonical?.headers,
  );
  return {
    kind: 'accepted',
    destination: { ...(e164 ? { e164 } : { sipUri }), ...(headers ? { headers } : {}) },
    ...withRef,
  };
}

export type DestinationRefusal =
  | 'missing'
  | 'ambiguous'
  | 'e164_format'
  | 'e164_prefix'
  | 'sip_uri_invalid'
  | 'sip_scheme'
  | 'sip_host'
  | 'header_value';
/** A carrier-ready target: the shapes of `HandoffTarget` a queue can produce. */
export type CheckedTarget =
  { kind: 'phone'; e164: string } | { kind: 'sip'; uri: string; headers: Record<string, string> };

const E164 = /^\+[1-9][0-9]{5,14}$/;
/** `sip:`/`sips:`, optional plain user (no password), a DNS or IPv4 host, optional port; no params, headers or whitespace. */
const SIP_URI =
  /^(sips?):(?:([A-Za-z0-9._~%+-]{1,128})@)?([A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::([0-9]{1,5}))?$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,256}$/;

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) && host.length > entry.length : host === entry,
  );
}

/**
 * Whether a third party's destination is inside the queue's policy: an E.164 number under an
 * allowed prefix, or a SIP URI on an allowed host (`sips:` unless relaxed). Headers the policy does
 * not list are dropped; a listed header with an unprintable or oversize value refuses the answer.
 */
export function checkDestination(
  policy: DestinationPolicy,
  answer: WebhookDestination,
): { ok: true; target: CheckedTarget } | { ok: false; reason: DestinationRefusal } {
  const { e164, sipUri } = answer;
  if (e164 === undefined && sipUri === undefined) return { ok: false, reason: 'missing' };
  if (e164 !== undefined && sipUri !== undefined) return { ok: false, reason: 'ambiguous' };
  if (e164 !== undefined) {
    if (!E164.test(e164)) return { ok: false, reason: 'e164_format' };
    if (!policy.allowE164Prefixes.some((prefix) => e164.startsWith(prefix)))
      return { ok: false, reason: 'e164_prefix' };
    return { ok: true, target: { kind: 'phone', e164 } };
  }
  const match = SIP_URI.exec(sipUri!);
  if (!match) return { ok: false, reason: 'sip_uri_invalid' };
  const [, scheme, , rawHost, port] = match;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535))
    return { ok: false, reason: 'sip_uri_invalid' };
  if (scheme === 'sip' && !policy.allowInsecureSip) return { ok: false, reason: 'sip_scheme' };
  if (!hostAllowed(rawHost!.toLowerCase(), policy.allowSipHosts))
    return { ok: false, reason: 'sip_host' };
  const headers: Record<string, string> = {};
  const listed = new Map(policy.allowedHeaders.map((name) => [name.toLowerCase(), name]));
  for (const [name, value] of Object.entries(answer.headers ?? {})) {
    const canonical = listed.get(name.toLowerCase());
    if (!canonical) continue;
    if (!HEADER_VALUE.test(value)) return { ok: false, reason: 'header_value' };
    headers[canonical] = value;
  }
  return { ok: true, target: { kind: 'sip', uri: sipUri!, headers } };
}
