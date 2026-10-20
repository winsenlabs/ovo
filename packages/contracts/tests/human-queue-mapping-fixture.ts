import {
  EXTERNAL_CONTEXT_DEFAULT,
  WebhookSpec,
  type HumanQueueContext,
  type QueueContextPolicy,
} from '../src/index.ts';

export const context = (patch: Partial<HumanQueueContext> = {}): HumanQueueContext => ({
  call: { id: 'job-1', direction: 'inbound', startedAt: '2026-10-15T09:00:00.000Z' },
  caller: { number: '+919800000000', calledNumber: '+914000000000' },
  route: {
    path: ['intent', 'billing'],
    language: 'hi',
    intent: 'billing',
    context: { tier: 'gold' },
  },
  handover: {
    summary: 'Caller disputes a charge.',
    reason: 'wants a person',
    transcript: [{ role: 'caller', text: 'I want a person' }],
  },
  variables: { account_id: 'A-77', vip: true, age: 4 },
  queue: { key: 'support-desk', id: 'q1', name: 'Support desk' },
  ticket: {
    id: 't1',
    idempotencyKey: 'hq:org:job-1:1',
    priority: 1,
    callbackUrl: 'https://ovo.example.com/api/v1/human-queue/callbacks/t1',
    contextUrl: 'https://ovo.example.com/api/v1/human-queue/context/t1?t=tok',
    transcriptUrl: 'https://ovo.example.com/api/v1/human-queue/transcript/t1?t=tok',
    expiresAt: '2026-10-15T09:03:00.000Z',
  },
  time: { now: '2026-10-15T09:00:05.000Z' },
  ...patch,
});
export const spec = (patch: Record<string, unknown> = {}) =>
  WebhookSpec.parse({ url: 'https://acd.example.com/h', credentialId: 'c', ...patch });
export const body = (value: Record<string, unknown>) => spec({ body: value });
export const policy = (patch: Partial<QueueContextPolicy> = {}): QueueContextPolicy => ({
  ...EXTERNAL_CONTEXT_DEFAULT,
  ...patch,
});
