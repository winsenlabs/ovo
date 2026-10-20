import { z } from 'zod';
import {
  checkDestination,
  encodeWebhookBody,
  mappingIssues,
  parseWebhookResponse,
  QueueContextPolicy,
  renderMapping,
  WebhookSpec,
  type HumanQueueDefinition,
} from '@winsendotai/ovo-contracts';
import type { EgressAttempt, EgressRequest, RateLimiter } from '../human-queue-ports.ts';
import { syntheticContext } from '../human-queue-synthetic.ts';
import {
  invalid,
  queued,
  zodIssues,
  type HumanQueueRouteDependencies,
} from './human-queue-support.ts';
import { sendError, type RoutingAudit } from './routing-support.ts';

const PreviewBody = z.object({ spec: z.unknown(), policy: z.unknown() }).strict();
const QueueParams = z.object({ queueId: z.uuid() });
/** A preview renders as the form is typed, so the spec is checked leniently (below). */
const PLACEHOLDER = {
  url: 'https://preview.example.com/',
  credentialId: 'preview',
  auth: { kind: 'none' },
};

/** The queue's own names for the synthetic context's links and routing keys. */
const previewQueue = (name: string) => ({ key: 'preview', id: 'queue-preview', name });

/**
 * `POST /v1/human-queues/preview` and `POST /v1/human-queues/:id/test-webhook` (design 6.1).
 * Preview is pure: it renders the mapping against a synthetic call and reports the mapping's
 * issues. Test sends that synthetic request through the real client and egress policy to the
 * saved queue's endpoint (admin only, ten a minute) and returns it redacted, with each attempt
 * and the parsed answer; it creates no ticket and touches no call.
 */
export function registerHumanQueuePreviewRoutes(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit; testLimiter: RateLimiter },
): void {
  const now = input.now ?? Date.now;

  input.app.post(
    '/v1/human-queues/preview',
    queued(input, 'editor', ({ request, reply }) => {
      const body = PreviewBody.safeParse(request.body ?? {});
      if (!body.success)
        return invalid(reply, 'queue_invalid', 'Request body is invalid', zodIssues(body.error));
      const policy = QueueContextPolicy.safeParse(body.data.policy);
      if (!policy.success)
        return invalid(
          reply,
          'queue_invalid',
          'Context policy is invalid',
          zodIssues(policy.error),
        );
      const given = body.data.spec && typeof body.data.spec === 'object' ? body.data.spec : {};
      // Only the mapping, format and headers matter here; the rest is a placeholder so a
      // half-typed form still previews.
      const spec = WebhookSpec.safeParse({ ...given, ...PLACEHOLDER });
      if (!spec.success) return { issues: zodIssues(spec.error) };
      const issues = mappingIssues(spec.data, policy.data);
      const context = syntheticContext({
        policy: policy.data,
        queue: previewQueue('Preview'),
        callbackBaseUrl: input.callbackBaseUrl,
        now: new Date(now()),
      });
      return { body: renderMapping(spec.data.body, context, spec.data.format), issues };
    }),
  );

  input.app.post(
    '/v1/human-queues/:queueId/test-webhook',
    queued(input, 'admin', async ({ request, reply, principal, queues, audit }) => {
      const { queueId } = QueueParams.parse(request.params);
      if (!input.flags.webhookEnabled)
        return sendError(
          reply,
          503,
          'webhook_disabled',
          'Outbound human queue webhooks are not enabled',
        );
      const queue = await queues.queues.get(queueId);
      if (!queue) return sendError(reply, 404, 'queue_not_found', 'Human queue not found');
      const definition: HumanQueueDefinition = queue.definition;
      if (definition.kind !== 'external')
        return sendError(reply, 422, 'queue_not_external', 'Only a webhook queue can be tested');
      const limiterKey = `${principal.workspaceId}:${principal.identityId}`;
      if (!input.testLimiter.take(limiterKey))
        return reply
          .header('retry-after', String(input.testLimiter.retryAfterSeconds(limiterKey)))
          .code(429)
          .send({
            error: { code: 'rate_limited', message: 'Ten webhook tests a minute are allowed' },
          });

      const { webhook } = definition;
      const secrets = input.secrets;
      let secret: string;
      let authSecret: string | undefined;
      try {
        if (!secrets) throw new Error('Secrets are not configured');
        secret = await secrets.resolve(principal.workspaceId, webhook.credentialId);
        if (webhook.auth.kind !== 'none')
          authSecret = await secrets.resolve(principal.workspaceId, webhook.auth.credentialId);
      } catch {
        return sendError(
          reply,
          422,
          'credential_unavailable',
          'A credential this queue uses is not available',
        );
      }
      const context = syntheticContext({
        policy: definition.context,
        queue: { key: 'test', id: queue.id, name: definition.name },
        callbackBaseUrl: input.callbackBaseUrl,
        now: new Date(now()),
      });
      const rendered = renderMapping(webhook.body, context, webhook.format);
      const encoded = encodeWebhookBody(rendered, webhook.format);
      const authHeader =
        webhook.auth.kind === 'bearer'
          ? { name: 'authorization', value: `Bearer ${authSecret}` }
          : webhook.auth.kind === 'header'
            ? { name: webhook.auth.name, value: authSecret! }
            : undefined;
      const request_: EgressRequest = {
        url: webhook.url,
        method: webhook.method,
        contentType: encoded.contentType,
        body: encoded.body,
        headers: {
          ...webhook.headers,
          ...(authHeader ? { [authHeader.name]: authHeader.value } : {}),
        },
        secret,
        secretHeaders: authHeader ? [authHeader.name.toLowerCase()] : [],
        idempotencyKey: context.ticket.idempotencyKey,
        timeoutMs: webhook.timeoutMs,
        retry: webhook.retry,
      };
      const attempts: EgressAttempt[] = [];
      const outcome = await input.egress.send(request_, (attempt) => attempts.push(attempt));
      const shown = input.egress.redact(request_);
      await audit(principal, 'human_queue.test_webhook', 'human_queue', queueId, {
        ok: outcome.ok,
        attempts: attempts.length,
      });
      const answer = outcome.ok
        ? parseWebhookResponse(webhook, outcome.status, outcome.json)
        : undefined;
      return {
        request: { url: shown.url, headers: shown.headers, body: rendered },
        attempts,
        ...(outcome.ok ? {} : { failure: outcome.reason }),
        ...(answer
          ? {
              answer:
                answer.kind === 'accepted'
                  ? {
                      kind: answer.kind,
                      destination: answer.destination,
                      destinationCheck: checkDestination(definition.destination, answer.destination)
                        .ok
                        ? 'allowed'
                        : 'refused',
                    }
                  : answer.kind === 'queued'
                    ? { kind: answer.kind }
                    : { kind: answer.kind, reason: answer.reason },
            }
          : {}),
      };
    }),
  );
}
