import type { ExternalQueue, Ticket, TicketReleaseCode } from './human-contract.ts';
import { HumanAttempt, type HumanAttemptInit } from './human-attempt.ts';
import { ExternalHandoffSegment, sipContextHeaders } from './human-carrier.ts';
import { humanState, humanWebhook } from './human-events.ts';
import {
  buildWebhookRequest,
  cancelHandoff,
  deliver,
  webhookContext,
  webhookCredentials,
} from './human-webhook.ts';
import {
  checkDestination,
  parseWebhookResponse,
  type CheckedTarget,
  type HumanQueueContext,
} from '@winsendotai/ovo-contracts';
import type { StartableSegment } from './transfer-attempt.ts';
import type { WebhookRequest } from '@winsendotai/ovo-session-host';

const NEVER = new AbortController().signal;

/**
 * A third-party queue (human queue design 7.4): one signed webhook with the call's context, then
 * the answer. A synchronous destination, or `queued` and a destination written to the ticket by
 * the signed callback the API verifies, becomes an `ExternalHandoffSegment`; a rejection, an
 * answer outside the destination policy, or a webhook that never got through fails the attempt
 * with a code the hold's chain acts on. The third party is told when OVO gives up.
 */
export class HumanExternalAttempt extends HumanAttempt {
  /** What was sent; `reached` once the third party took it (accepted or queued it). */
  private attempted?: { request: WebhookRequest; context: HumanQueueContext };
  private reached?: { request: WebhookRequest; context: HumanQueueContext };

  constructor(init: HumanAttemptInit) {
    super(init);
  }

  private get def(): ExternalQueue {
    return this.queue.definition as ExternalQueue;
  }

  protected async run(signal: AbortSignal): Promise<StartableSegment | string> {
    const { deps } = this.rt;
    const { def } = this;
    const ticket = this.ticket!;
    const breaker = deps.shared.breaker(this.queue.id);
    let sent;
    try {
      sent = await this.send(ticket, signal);
    } catch {
      // swallow-ok: a credential that cannot be read is a webhook that cannot be sent.
      deps.audit('human.webhook.failed', {
        queue: this.queue.key,
        reason: 'credential_unavailable',
      });
      breaker.failure();
      return 'webhook_failed';
    }
    if (typeof sent === 'string') return sent;
    if (!sent.ok) {
      if (signal.aborted) return 'call_ended';
      breaker.failure();
      return 'webhook_failed';
    }
    breaker.success();
    const answer = parseWebhookResponse(def.webhook, sent.status, sent.json);
    // Only a third party that took the handoff (accepted or queued it) is told OVO gave up.
    if (answer.kind === 'accepted' || answer.kind === 'queued') this.reached = this.attempted;
    const report = (outcome: 'accepted' | 'queued' | 'rejected', reason?: string) =>
      deps.record(
        'human.webhook',
        humanWebhook(ticket.id, {
          attempt: sent.attempts,
          outcome,
          ms: 0,
          ...(reason ? { reason } : {}),
        }),
      );
    if (answer.kind === 'invalid') {
      deps.record(
        'human.webhook',
        humanWebhook(ticket.id, {
          attempt: sent.attempts,
          outcome: 'failed',
          ms: 0,
          reason: 'invalid',
        }),
      );
      breaker.failure();
      return 'webhook_failed';
    }
    if (answer.kind === 'rejected') {
      report('rejected', answer.reason);
      return 'webhook_rejected';
    }
    if (answer.kind === 'accepted') {
      report('accepted');
      return this.readySegment(answer.destination, 'sync');
    }
    report('queued');
    return this.awaitDestination(signal);
  }

  /** Builds and delivers the handoff; a string is a failure code, `ok: false` a failed delivery. */
  private async send(ticket: Ticket, signal: AbortSignal) {
    const { deps } = this.rt;
    const { def } = this;
    const credentials = await webhookCredentials(deps.secrets, deps.call.workspaceId, def.webhook);
    const token = await deps.service.tickets
      .issueContextToken(ticket.id, 15 * 60)
      .catch(() => undefined);
    const origin = `${deps.callbackBaseUrl}/api/v1/human-queue`;
    const links = token
      ? {
          contextUrl: `${origin}/context/${ticket.id}?t=${token}`,
          transcriptUrl: `${origin}/context/${ticket.id}/transcript?t=${token}`,
        }
      : {};
    const context = webhookContext(def, {
      ticket,
      idempotencyKey: this.idempotencyKey,
      queue: { key: this.queue.key, id: this.queue.id, name: def.name },
      context: this.ticketContext,
      call: {
        id: deps.call.callId,
        direction: deps.call.direction,
        startedAt: deps.call.startedAt,
      },
      callbackUrl: `${origin}/callbacks/${ticket.id}`,
      ...links,
      now: deps.clock.now(),
    });
    const left = new Date(ticket.expiresAt).getTime() - deps.clock.now();
    const request = buildWebhookRequest(def, context, credentials, left, signal);
    if (!request) return 'webhook_failed';
    this.attempted = { request, context };
    return deliver(request, ticket.id, {
      record: deps.record,
      log: deps.log,
      ...(deps.network ? { network: deps.network } : {}),
      now: () => deps.clock.now(),
      sleep: (ms, abort) => deps.clock.sleep(ms, abort ?? NEVER),
      ...(deps.random ? { random: deps.random } : {}),
    });
  }

  /** The destination the third party answered with, policy-checked, as a segment ready to start. */
  private readySegment(
    destination: Parameters<typeof checkDestination>[1],
    via: 'sync' | 'callback',
  ): StartableSegment | string {
    const { deps } = this.rt;
    const ticket = this.ticket!;
    const checked = checkDestination(this.def.destination, destination);
    if (!checked.ok) {
      deps.record(
        'human.webhook',
        humanWebhook(ticket.id, {
          attempt: 1,
          outcome: 'failed',
          ms: 0,
          reason: `destination_refused:${checked.reason}`,
        }),
      );
      return `destination_refused:${checked.reason}`;
    }
    if (via === 'callback')
      deps.record('human.state', humanState(ticket.id, 'destination', { by: 'callback' }));
    const language = deps.memory.route?.language ?? 'en';
    return new ExternalHandoffSegment(this, {
      index: this.index,
      queue: this.queue,
      ticketId: ticket.id,
      language,
      destination: checked.target,
      headers: this.headers(checked.target),
      handoff: (target, id) => deps.carrierHandoff!(target, id),
      markHandedOff: () => deps.service.tickets.markHandedOff(ticket.id),
      endHandedOff: () => deps.endHandedOff(),
      record: deps.record,
    });
  }

  /** The SIP context headers: ours, then the answer's own (already policy-checked). */
  private headers(target: CheckedTarget): Record<string, string> {
    if (target.kind !== 'sip') return {};
    const { context } = this.attempted ?? {};
    const own = this.ticketContext;
    return sipContextHeaders({
      callId: this.rt.deps.call.callId,
      ticketId: this.ticket!.id,
      ...(own.language && this.def.context.language ? { language: own.language } : {}),
      ...(own.intent && this.def.context.intent ? { intent: own.intent } : {}),
      ...(context?.ticket.contextUrl ? { contextUrl: context.ticket.contextUrl } : {}),
      answered: target.headers,
    });
  }

  /** A `queued` answer: wait for the callback to write a destination, or the ticket to end. */
  private async awaitDestination(signal: AbortSignal): Promise<StartableSegment | string> {
    const { deps } = this.rt;
    const ticketId = this.ticket!.id;
    for (;;) {
      await deps.clock.sleep(deps.pollMs, signal);
      if (signal.aborted) return 'call_ended';
      const current = await deps.service.tickets.get(ticketId).catch(() => undefined);
      if (!current) continue;
      if (current.destination) return this.readySegment(current.destination, 'callback');
      if (current.status === 'released') return 'webhook_rejected';
      if (current.status === 'expired') return 'ticket_expired';
    }
  }

  protected async cleanup(_code: TicketReleaseCode): Promise<void> {
    const { reached, def } = this;
    if (!reached || !def.webhook.cancel) return;
    const { deps } = this.rt;
    // Best effort, once: tell the third party OVO gave up on this ticket.
    await cancelHandoff(reached.request, def.webhook.format, reached.context, this.ticket!.id, {
      record: deps.record,
      ...(deps.network ? { network: deps.network } : {}),
      now: () => deps.clock.now(),
    });
  }
}
