import type { FieldMapping, MappingRef, MappingTemplate, MappingValue } from './webhook.ts';

/**
 * Pure rendering of a queue's webhook body. No eval, no user regexes, no loops: a mapping is a
 * literal tree whose leaves may name a context path (`$from`) or a `{{path}}` template. Namespaces
 * the queue's context policy turned off are simply absent from the context, so they render empty.
 */
export type ContextScalar = string | number | boolean | null;
export interface HumanQueueContext {
  call?: { id?: string; direction?: string; startedAt?: string };
  caller?: { number?: string; calledNumber?: string };
  route?: {
    path?: readonly string[];
    language?: string;
    intent?: string;
    context?: Readonly<Record<string, string>>;
  };
  handover?: {
    summary?: string;
    reason?: string;
    transcript?: readonly { role: 'caller' | 'agent'; text: string }[];
  };
  variables?: Readonly<Record<string, string | number | boolean>>;
  queue: { key: string; id: string; name: string };
  ticket: {
    id: string;
    idempotencyKey: string;
    priority: number;
    callbackUrl: string;
    contextUrl?: string;
    transcriptUrl?: string;
    expiresAt: string;
    /** `handoff` unless this is the cancel post. */
    event?: 'handoff' | 'cancelled';
  };
  time: { now: string };
  /** Set by the API's `test-webhook`: the context is synthetic. */
  test?: boolean;
}

export const WEBHOOK_REQUEST_SCHEMA = 'ovo.human-queue/1';
export const WEBHOOK_RESPONSE_SCHEMA = 'ovo.human-queue-response/1';
export const WEBHOOK_CALLBACK_SCHEMA = 'ovo.human-queue-callback/1';

/** The value at a dotted context path, or `undefined` when any step is missing. */
export function readContextPath(context: HumanQueueContext, path: string): unknown {
  let at: unknown = context;
  for (const step of path.split('.')) {
    if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined;
    if (!Object.hasOwn(at, step)) return undefined;
    at = (at as Record<string, unknown>)[step];
  }
  return at;
}

const isRef = (value: object): value is MappingRef => '$from' in value;
const isTemplate = (value: object): value is MappingTemplate => '$template' in value;
const TEMPLATE_SLOT = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

const clip = (text: string, maxChars: number | undefined): string =>
  maxChars === undefined ? text : [...text].slice(0, maxChars).join('');

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function convert(value: unknown, as: 'string' | 'number' | 'boolean' | 'json' | undefined) {
  if (as === 'string') return asText(value);
  if (as === 'number') {
    const parsed = typeof value === 'number' ? value : Number(asText(value));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (as === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
  return value;
}

/** A scalar value in a template renders as text; objects, arrays and absences render empty. */
function renderTemplate(template: string, context: HumanQueueContext): string {
  return template.replace(TEMPLATE_SLOT, (_, path: string) => {
    const found = readContextPath(context, path);
    return found !== null && typeof found === 'object' ? '' : asText(found);
  });
}

const OMIT = Symbol('omit');

function renderValue(value: MappingValue, context: HumanQueueContext): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => {
      const rendered = renderValue(item, context);
      return rendered === OMIT ? null : rendered;
    });
  if (isRef(value)) {
    const found = readContextPath(context, value.$from);
    if (found === undefined || found === null) {
      if (value.default === undefined) return OMIT;
      return typeof value.default === 'string'
        ? clip(value.default, value.maxChars)
        : value.default;
    }
    const converted = convert(found, value.as);
    return typeof converted === 'string' ? clip(converted, value.maxChars) : converted;
  }
  if (isTemplate(value)) return clip(renderTemplate(value.$template, context), value.maxChars);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const rendered = renderValue(child as MappingValue, context);
    if (rendered !== OMIT) out[key] = rendered;
  }
  return out;
}

function flatten(rendered: Record<string, unknown>): Record<string, string> {
  const form: Record<string, string> = {};
  for (const [key, value] of Object.entries(rendered)) form[key] = asText(value);
  return form;
}

/**
 * The canonical `ovo.human-queue/1` body. Only sections the context carries appear, so a queue whose
 * policy turns the caller number off sends no `caller` at all.
 */
export function canonicalWebhookBody(context: HumanQueueContext): Record<string, unknown> {
  const { ticket } = context;
  const body: Record<string, unknown> = {
    schema: WEBHOOK_REQUEST_SCHEMA,
    event: ticket.event ?? 'handoff',
    ticket: {
      id: ticket.id,
      idempotencyKey: ticket.idempotencyKey,
      priority: ticket.priority,
      expiresAt: ticket.expiresAt,
      callbackUrl: ticket.callbackUrl,
    },
    queue: { key: context.queue.key, name: context.queue.name },
  };
  const section = (name: string, value: Record<string, unknown> | undefined) => {
    if (!value) return;
    const kept = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
    if (Object.keys(kept).length > 0) body[name] = kept;
  };
  section('call', context.call);
  section('caller', context.caller);
  section('route', context.route && { ...context.route, context: undefined });
  section('handover', context.handover);
  section('variables', context.variables);
  section('links', { context: ticket.contextUrl, transcript: ticket.transcriptUrl });
  if (context.test) body.test = true;
  return body;
}

/**
 * The request body for a queue's mapping: the canonical body when `mapping` is absent. For `form`
 * the result is flat (every value text; a nested value is its JSON).
 */
export function renderMapping(
  mapping: FieldMapping | undefined,
  context: HumanQueueContext,
  format: 'json' | 'form',
): Record<string, unknown> | Record<string, string> {
  const normal = {
    ...context,
    ticket: { ...context.ticket, event: context.ticket.event ?? 'handoff' },
  };
  const rendered =
    mapping === undefined
      ? canonicalWebhookBody(normal)
      : (renderValue(mapping as MappingValue, normal) as Record<string, unknown>);
  return format === 'form' ? flatten(rendered) : rendered;
}

/** The wire bytes of a rendered body (`application/json` or `application/x-www-form-urlencoded`). */
export function encodeWebhookBody(
  rendered: Record<string, unknown>,
  format: 'json' | 'form',
): { contentType: string; body: string } {
  if (format === 'json') return { contentType: 'application/json', body: JSON.stringify(rendered) };
  return {
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams(flatten(rendered)).toString(),
  };
}
