import {
  redactWebhookRequest,
  sendWebhook,
  verifyWebhookSignature,
} from '@winsendotai/ovo-session-host';
import type { HumanQueueEgress } from './human-queue-ports.ts';

/**
 * The production egress: the session host's pinned, signed webhook client and signature check,
 * the same code the worker's human queue attempts run, so `test-webhook` and callback
 * verification can never disagree with a live call.
 */
export const sessionHostEgress: HumanQueueEgress = {
  send: (request, onAttempt) => sendWebhook(request, { onAttempt }),
  redact: (request) => redactWebhookRequest(request),
  verify: (input) => verifyWebhookSignature(input),
};
