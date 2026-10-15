import type { WebhookDestination, WebhookSpec } from './human-contract.ts';

/*
 * The pure wire functions of human queue design 4.2: render a field-mapping over the call's
 * context, the canonical request body, read the third party's answer, and check its destination
 * against the queue's policy. Core's contracts own these (the API validates and previews with the
 * same code); the worker uses this equivalent until it rebases on them, and `human-webhook.ts` is
 * the only importer, so the swap is that file's import line.
 */

/** What a mapping may read; absent namespaces are the queue's context policy turning them off. */
export interface HumanQueueContext {
  call?: { id: string; direction: string; startedAt: string };
  caller?: { number?: string; calledNumber?: string };
  route?: { path?: string[]; language?: string; intent?: string; context?: Record<string, string> };
  handover?: {
    summary?: string;
    reason?: string;
    transcript?: { role: 'caller' | 'agent'; text: string }[];
  };
  variables?: Record<string, string | number | boolean>;
  queue: { key: string; id: string; name: string };
  ticket: {
    id: string;
    idempotencyKey: string;
    priority: number;
    callbackUrl: string;
    contextUrl?: string;
    transcriptUrl?: string;
    expiresAt: string;
  };
  time: { now: string };
}

function lookup(context: unknown, path: string): unknown {
  let node: unknown = context;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const asText = (value: unknown): string =>
  value === undefined || value === null
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

function ref(node: Record<string, unknown>, context: HumanQueueContext): unknown {
  const found = lookup(context, String(node.$from));
  let value: unknown = found === undefined ? (node.default ?? '') : found;
  if (typeof node.maxChars === 'number' && typeof value === 'string')
    value = value.slice(0, node.maxChars);
  switch (node.as) {
    case 'string':
      return asText(value);
    case 'number':
      return Number(value);
    case 'boolean':
      return value === true || value === 'true';
    case 'json':
      return JSON.stringify(value);
    default:
      return value;
  }
}

function render(node: unknown, context: HumanQueueContext): unknown {
  if (Array.isArray(node)) return node.map((item) => render(item, context));
  if (node === null || typeof node !== 'object') return node;
  const object = node as Record<string, unknown>;
  if (typeof object.$from === 'string') return ref(object, context);
  if (typeof object.$template === 'string') {
    const text = object.$template.replace(
      /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
      (_match, path: string) => asText(lookup(context, path)),
    );
    return typeof object.maxChars === 'number' ? text.slice(0, object.maxChars) : text;
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, render(value, context)]),
  );
}

/** The mapped body as the bytes to send: JSON, or flat `application/x-www-form-urlencoded`. */
export function renderBody(
  mapping: WebhookSpec['body'],
  context: HumanQueueContext,
  format: 'json' | 'form',
): { body: string; contentType: string } {
  return encodeBody(mapping ? render(mapping, context) : canonicalWebhookBody(context), format);
}

/** A body value as the bytes to send: JSON, or flat `application/x-www-form-urlencoded`. */
export function encodeBody(
  value: unknown,
  format: 'json' | 'form',
): { body: string; contentType: string } {
  if (format === 'json') return { body: JSON.stringify(value), contentType: 'application/json' };
  const form = new URLSearchParams();
  for (const [key, field] of Object.entries(value as Record<string, unknown>))
    form.set(key, asText(field));
  return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' };
}

/** `ovo.human-queue/1`: the request when a queue has no body mapping. */
export function canonicalWebhookBody(context: HumanQueueContext): Record<string, unknown> {
  const { ticket, queue } = context;
  return {
    schema: 'ovo.human-queue/1',
    event: 'handoff',
    ticket: {
      id: ticket.id,
      idempotencyKey: ticket.idempotencyKey,
      priority: ticket.priority,
      expiresAt: ticket.expiresAt,
      callbackUrl: ticket.callbackUrl,
    },
    queue: { key: queue.key, name: queue.name },
    ...(context.call ? { call: context.call } : {}),
    ...(context.caller ? { caller: context.caller } : {}),
    ...(context.route ? { route: context.route } : {}),
    ...(context.handover ? { handover: context.handover } : {}),
    ...(context.variables ? { variables: context.variables } : {}),
    ...(ticket.contextUrl || ticket.transcriptUrl
      ? {
          links: {
            ...(ticket.contextUrl ? { context: ticket.contextUrl } : {}),
            ...(ticket.transcriptUrl ? { transcript: ticket.transcriptUrl } : {}),
          },
        }
      : {}),
  };
}

/** The `cancelled` event body: the same ticket block, no call data. */
export function cancelledWebhookBody(context: HumanQueueContext): Record<string, unknown> {
  return {
    schema: 'ovo.human-queue/1',
    event: 'cancelled',
    ticket: { id: context.ticket.id, idempotencyKey: context.ticket.idempotencyKey },
    queue: { key: context.queue.key, name: context.queue.name },
  };
}

export type WebhookAnswer =
  | { kind: 'accepted'; destination: WebhookDestination; ticketRef?: string }
  | { kind: 'queued'; ticketRef?: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'invalid'; reason: 'status' | 'destination' | 'json' };

function pointer(doc: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let node = doc;
  for (const part of path.split('/').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return node;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** Reads the third party's 2xx answer: the canonical response, or the queue's response mapping. */
export function parseWebhookResponse(spec: WebhookSpec, body: unknown): WebhookAnswer {
  if (body === null || typeof body !== 'object') return { kind: 'invalid', reason: 'json' };
  const map = spec.response;
  const canonical = !map.statusPath;
  const status = text(
    canonical ? (body as Record<string, unknown>).status : pointer(body, map.statusPath),
  );
  if (!status) return { kind: 'invalid', reason: 'status' };
  const ticketRef = text(
    pointer(body, map.ticketRefPath ?? (canonical ? '/ticketRef' : undefined)),
  );
  const withRef = ticketRef ? { ticketRef } : {};
  if (map.queuedValues.includes(status)) return { kind: 'queued', ...withRef };
  if (map.rejectedValues.includes(status))
    return {
      kind: 'rejected',
      reason: text(pointer(body, '/reason'))?.slice(0, 60) ?? status.slice(0, 60),
    };
  if (!map.acceptedValues.includes(status)) return { kind: 'invalid', reason: 'status' };
  const e164 = text(
    pointer(body, map.destinationE164Path ?? (canonical ? '/destination/e164' : undefined)),
  );
  const sipUri = text(
    pointer(body, map.destinationSipUriPath ?? (canonical ? '/destination/sipUri' : undefined)),
  );
  const headers = pointer(
    body,
    map.destinationHeadersPath ?? (canonical ? '/destination/headers' : undefined),
  );
  if (!e164 && !sipUri) return { kind: 'invalid', reason: 'destination' };
  const destination: WebhookDestination = {
    ...(e164 ? { e164 } : {}),
    ...(sipUri ? { sipUri } : {}),
    ...(headers && typeof headers === 'object' && !Array.isArray(headers)
      ? {
          headers: Object.fromEntries(
            Object.entries(headers).filter(([, v]) => typeof v === 'string'),
          ) as Record<string, string>,
        }
      : {}),
  };
  return { kind: 'accepted', destination, ...withRef };
}

export {
  checkDestination,
  type CheckedDestination,
  type DestinationRefusal,
} from './human-destination.ts';
