import {
  encodeWebhookBody,
  MAPPING_LIMITS,
  renderMapping,
  WEBHOOK_REQUEST_SCHEMA,
  type HumanQueueContext,
  type SecretResolver,
} from '@winsendotai/ovo-contracts';
import {
  sendCancel,
  sendWebhook,
  type WebhookDeps,
  type WebhookOutcome,
  type WebhookRequest,
} from '@winsendotai/ovo-session-host';
import type { ExternalQueue, Ticket, TicketContext } from './human-contract.ts';
import { humanWebhook } from './human-events.ts';

/** The `cancelled` post: the same ticket block and the queue, none of the call (design 4.2.1). */
export function cancelledWebhookBody(context: HumanQueueContext): Record<string, unknown> {
  return {
    schema: WEBHOOK_REQUEST_SCHEMA,
    event: 'cancelled',
    ticket: { id: context.ticket.id, idempotencyKey: context.ticket.idempotencyKey },
    queue: { key: context.queue.key, name: context.queue.name },
  };
}

export interface WebhookTicket {
  ticket: Pick<Ticket, 'id' | 'priority' | 'expiresAt'>;
  idempotencyKey: string;
  queue: { key: string; id: string; name: string };
  context: TicketContext;
  call: { id: string; direction: string; startedAt: number };
  callbackUrl: string;
  contextUrl?: string;
  transcriptUrl?: string;
  now: number;
}

/**
 * The mapping's context (design 4.2): only what the queue's policy turns on. The ticket context
 * was already built under that policy, so a field it left out is simply absent here and renders
 * empty in a template.
 */
export function webhookContext(def: ExternalQueue, input: WebhookTicket): HumanQueueContext {
  const { context, ticket } = input;
  const policy = def.context;
  const handover = {
    ...(context.summary ? { summary: context.summary } : {}),
    ...(context.reason ? { reason: context.reason } : {}),
    ...(context.transcript.length ? { transcript: context.transcript } : {}),
  };
  return {
    call: {
      id: context.callId,
      direction: input.call.direction,
      startedAt: new Date(input.call.startedAt).toISOString(),
    },
    ...(context.caller.number || context.caller.calledNumber ? { caller: context.caller } : {}),
    route: {
      path: context.routePath,
      ...(context.language ? { language: context.language } : {}),
      ...(context.intent ? { intent: context.intent } : {}),
    },
    ...(Object.keys(handover).length ? { handover } : {}),
    ...(Object.keys(context.variables).length ? { variables: context.variables } : {}),
    queue: input.queue,
    ticket: {
      id: ticket.id,
      idempotencyKey: input.idempotencyKey,
      priority: ticket.priority,
      callbackUrl: input.callbackUrl,
      ...(input.contextUrl ? { contextUrl: input.contextUrl } : {}),
      ...(policy.transcriptLink && input.transcriptUrl
        ? { transcriptUrl: input.transcriptUrl }
        : {}),
      expiresAt: ticket.expiresAt,
    },
    time: { now: new Date(input.now).toISOString() },
  };
}

/** The signing secret and the extra auth header's credential, resolved for the router agent. */
export async function webhookCredentials(
  secrets: SecretResolver,
  workspaceId: string,
  spec: ExternalQueue['webhook'],
): Promise<{ secret: string; headers: Record<string, string>; secretHeaders: string[] }> {
  const secret = await secrets.resolve(workspaceId, spec.credentialId);
  if (spec.auth.kind === 'none') return { secret, headers: {}, secretHeaders: [] };
  const credential = await secrets.resolve(workspaceId, spec.auth.credentialId);
  const name = spec.auth.kind === 'bearer' ? 'authorization' : spec.auth.name.toLowerCase();
  return {
    secret,
    headers: { [name]: spec.auth.kind === 'bearer' ? `Bearer ${credential}` : credential },
    secretHeaders: [name],
  };
}

/** The signed request for a handoff, or undefined when the mapped body is over the size cap. */
export function buildWebhookRequest(
  def: ExternalQueue,
  context: HumanQueueContext,
  credentials: Awaited<ReturnType<typeof webhookCredentials>>,
  retryDeadlineMs: number,
  signal: AbortSignal,
): WebhookRequest | undefined {
  const spec = def.webhook;
  const { body, contentType } = encodeWebhookBody(
    renderMapping(spec.body, context, spec.format),
    spec.format,
  );
  if (Buffer.byteLength(body) > MAPPING_LIMITS.bodyBytes) return undefined;
  return {
    url: spec.url,
    method: spec.method,
    contentType,
    body,
    headers: { ...spec.headers, ...credentials.headers },
    secret: credentials.secret,
    secretHeaders: credentials.secretHeaders,
    idempotencyKey: context.ticket.idempotencyKey,
    timeoutMs: spec.timeoutMs,
    retry: { ...spec.retry, deadlineMs: Math.min(spec.retry.deadlineMs, retryDeadlineMs) },
    signal,
  };
}

/** Delivers the handoff; each attempt is reported (`human.webhook`) as it ends. */
export function deliver(
  request: WebhookRequest,
  ticketId: string,
  deps: WebhookDeps & {
    record(type: string, payload: Record<string, unknown>): void;
    log(event: string, fields: Record<string, unknown>): void;
  },
): Promise<WebhookOutcome> {
  const { record, log, ...rest } = deps;
  return sendWebhook(request, {
    ...rest,
    onAttempt: (attempt) => {
      const event = humanWebhook(ticketId, {
        attempt: attempt.attempt,
        outcome: attempt.outcome,
        ms: attempt.ms,
        ...(attempt.status !== undefined ? { status: attempt.status } : {}),
        ...(attempt.reason ? { reason: attempt.reason } : {}),
      });
      record('human.webhook', event);
      log('human_webhook', event);
    },
  });
}

/** The one best-effort `cancelled` post (design 7.4 step 6). */
export async function cancelHandoff(
  request: WebhookRequest,
  format: 'json' | 'form',
  context: HumanQueueContext,
  ticketId: string,
  deps: WebhookDeps & { record(type: string, payload: Record<string, unknown>): void },
): Promise<void> {
  const { record, ...rest } = deps;
  const { signal: _signal, ...bare } = request;
  const encoded = encodeWebhookBody(cancelledWebhookBody(context), format);
  const outcome = await sendCancel({ ...bare, ...encoded }, rest);
  record(
    'human.webhook',
    humanWebhook(ticketId, {
      attempt: 1,
      outcome: outcome.ok ? 'cancelled_sent' : 'failed',
      ms: 0,
      ...(outcome.ok ? {} : { reason: outcome.reason }),
    }),
  );
}
