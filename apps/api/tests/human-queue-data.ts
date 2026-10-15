import { createHmac } from 'node:crypto';
import {
  HumanQueueDefinition,
  type HumanQueue,
  type OperatorProfile,
  type TicketContext,
} from '@winsendotai/ovo-contracts';
import type { NewTicket, Ticket } from '@winsendotai/ovo-plugin-operations';
import type { HqApp } from './human-queue-fixtures.ts';
import { WORKSPACE } from './human-queue-fixtures.ts';

export const managed = (patch: Record<string, unknown> = {}) =>
  ({ kind: 'managed', name: `Desk ${seq()}`, ...patch }) as Record<string, unknown>;
export const external = (patch: Record<string, unknown> = {}) =>
  ({
    kind: 'external',
    name: `ACD ${seq()}`,
    webhook: { url: 'https://acd.example.com/h', credentialId: 'acd-hmac' },
    destination: {
      allowE164Prefixes: ['+9140'],
      allowSipHosts: ['.acd.example.com'],
      allowedHeaders: ['X-Acd-Ticket'],
    },
    ...patch,
  }) as Record<string, unknown>;
let counter = 0;
const seq = () => (counter += 1);

/** A queue straight into the service (bypassing the routes), parsed with the contract's defaults. */
export const makeQueue = (hq: HqApp, definition: Record<string, unknown>): Promise<HumanQueue> =>
  hq.service.queues.create(HumanQueueDefinition.parse(definition));

export const profile = (userId: string, patch: Partial<OperatorProfile> = {}): OperatorProfile => ({
  userId,
  displayName: userId.toUpperCase(),
  enabled: true,
  teamIds: [],
  languages: ['en'],
  capacity: 1,
  ...patch,
});

/** An operator who is online. */
export async function onlineOperator(
  hq: HqApp,
  userId: string,
  patch: Partial<OperatorProfile> = {},
) {
  await hq.service.operators.upsert(profile(userId, patch));
  await hq.service.operators.heartbeat(userId, 'AVAILABLE');
}

export const context = (patch: Partial<TicketContext> = {}): TicketContext => ({
  callId: 'call-1',
  brief: 'Language: English. Intent: billing.',
  summary: 'Caller asks about a charge.',
  reason: 'wants a person',
  language: 'en',
  intent: 'billing',
  routePath: ['intent', 'billing'],
  caller: { number: '+919800000000', calledNumber: '+918000000001' },
  transcript: [
    { role: 'caller', text: 'one' },
    { role: 'agent', text: 'two' },
    { role: 'caller', text: 'three' },
  ],
  variables: { account: 'A1', secret_note: 'hidden' },
  returnTargets: [{ key: 'bot', label: 'Bot' }],
  ...patch,
});

/** A ticket for a queue, as the worker writes it from the pinned definition. */
export async function openTicket(
  hq: HqApp,
  queue: HumanQueue,
  patch: Partial<NewTicket> = {},
): Promise<Ticket> {
  const { definition } = queue;
  const callId = patch.callId ?? `call-${seq()}`;
  const created = await hq.service.tickets.create({
    callId,
    idempotencyKey: `hq:${WORKSPACE}:${callId}:1`,
    queue: {
      id: queue.id,
      key: 'support',
      name: definition.name,
      kind: definition.kind,
      mode: definition.kind === 'managed' ? definition.assignment : 'OPEN_PICKUP',
      teamIds: definition.kind === 'managed' ? definition.teamIds : [],
      language: definition.kind === 'managed' ? definition.language : 'ignore',
      maxWaiting: definition.limits.maxWaiting,
    },
    priority: 0,
    language: 'en',
    callerMasked: '+91••••00',
    expiresAt: new Date(hq.now() + 180_000).toISOString(),
    routerAgentId: 'front-desk',
    credentialId: definition.kind === 'external' ? definition.webhook.credentialId : undefined,
    context: context({ callId }),
    contextRetentionHours: 24,
    ...patch,
  });
  if (created === 'queue_full') throw new Error('queue_full');
  return created;
}

/** The headers a third party signs a callback with. */
export function signedCallback(
  secret: string,
  body: unknown,
  options: { timestamp?: number; eventId?: string; now?: number } = {},
) {
  const eventId = options.eventId ?? `evt-${seq()}`;
  const timestamp = String(Math.floor((options.timestamp ?? options.now ?? Date.now()) / 1000));
  const text = typeof body === 'string' ? body : JSON.stringify({ eventId, ...(body as object) });
  return {
    payload: text,
    eventId,
    headers: {
      'content-type': 'application/json',
      'x-ovo-timestamp': timestamp,
      'x-ovo-event-id': eventId,
      'x-ovo-signature': `v1=${createHmac('sha256', secret).update(`${timestamp}.${eventId}.${text}`).digest('hex')}`,
    },
  };
}
