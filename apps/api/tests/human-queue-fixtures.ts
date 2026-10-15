import { createHmac } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  HumanQueueDefinition,
  type HumanQueue,
  type OperatorProfile,
  type TicketContext,
} from '@winsendotai/ovo-contracts';
import { fakeMediaRoom, type FakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import type { NewTicket, Ticket } from '@winsendotai/ovo-plugin-operations';
import { InMemoryHumanQueueService } from '@winsendotai/ovo-plugin-operations/testing';
import { MemoryCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { sessionHostEgress } from '../src/human-queue-egress.ts';
import type {
  EgressAttempt,
  EgressOutcome,
  EgressRequest,
  HumanQueueEgress,
} from '../src/human-queue-ports.ts';
import { registerHumanQueue } from '../src/routes/human-queue-index.ts';
import type { HumanQueueRouteDependencies } from '../src/routes/human-queue-support.ts';
import { fakeStore } from './routing-fixtures.ts';

export const WORKSPACE = 'ws-hq';
export const T0 = new Date('2026-10-15T09:00:00.000Z');
const RANK = { viewer: 0, editor: 1, admin: 2 } as const;
type Role = keyof typeof RANK;

/** A scripted webhook client: answers in order, records what it was asked to send. */
export class FakeEgress implements HumanQueueEgress {
  readonly sent: EgressRequest[] = [];
  script: (EgressOutcome | { attempts: EgressAttempt[]; outcome: EgressOutcome })[] = [];
  send = async (request: EgressRequest, onAttempt: (attempt: EgressAttempt) => void) => {
    this.sent.push(request);
    const next = this.script.shift() ?? {
      ok: true as const,
      status: 200,
      json: { status: 'queued' },
      attempts: 1,
    };
    const scripted = 'outcome' in next ? next : { attempts: [], outcome: next };
    const attempts = scripted.attempts.length
      ? scripted.attempts
      : [
          {
            attempt: 1,
            outcome: scripted.outcome.ok ? ('delivered' as const) : ('failed' as const),
            ms: 12,
          },
        ];
    for (const attempt of attempts) onAttempt(attempt);
    return scripted.outcome;
  };
  redact = (request: EgressRequest) => ({
    url: request.url.split('?')[0]!,
    method: request.method,
    headers: Object.fromEntries(
      Object.entries(request.headers ?? {}).map(([name, value]) =>
        request.secretHeaders?.includes(name.toLowerCase()) ? [name, '<redacted>'] : [name, value],
      ),
    ),
    body: request.body,
  });
  verify = sessionHostEgress.verify;
}

export interface HqApp {
  app: ReturnType<typeof Fastify>;
  service: InMemoryHumanQueueService;
  rooms?: FakeMediaRoom;
  egress: FakeEgress;
  outcomes: MemoryCallOutcomeStore;
  store: ReturnType<typeof fakeStore>;
  audits: Record<string, unknown>[];
  now: () => number;
  call: (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    options?: { payload?: unknown; user?: string; role?: Role; headers?: Record<string, string> },
  ) => ReturnType<ReturnType<typeof Fastify>['inject']>;
}

export interface HqAppOptions {
  enabled?: boolean;
  webhookEnabled?: boolean;
  /** No room server composed. */
  noRooms?: boolean;
  /** No PostgreSQL operations service at all. */
  noOperations?: boolean;
  users?: { id: string; email: string; label: string; disabled: boolean }[];
  credentials?: { id: string }[];
  sse?: HumanQueueRouteDependencies['sse'];
  secret?: string;
  /** Routing points by id, for the labels the desk gives send-back targets. */
  points?: Record<string, unknown>;
  /** `OVO_LIVEKIT_TOKEN_TTL_SECONDS`. */
  tokenTtlSeconds?: number;
  /** The secret store refuses every credential. */
  secretError?: boolean;
}

/** A Fastify app with only the human queue routes, over the in-memory service and a fake room. */
export function humanQueueApp(options: HqAppOptions = {}): HqApp {
  const app = Fastify({ logger: false });
  const service = new InMemoryHumanQueueService({
    organizationId: WORKSPACE,
    enabled: options.enabled ?? true,
  });
  service.clock.set(T0);
  const rooms = options.noRooms ? undefined : fakeMediaRoom();
  const store = fakeStore([], options.credentials ?? [{ id: 'acd-hmac' }, { id: 'acd-key' }]);
  const outcomes = new MemoryCallOutcomeStore();
  const egress = new FakeEgress();
  const now = () => service.clock.now().getTime();
  const secret = () => {
    if (options.secretError) throw new Error('Active credential not found');
    return options.secret ?? 'whsec-test';
  };
  app.setErrorHandler((caught, _request, reply) => {
    const thrown = caught as Error & { statusCode?: number; code?: string };
    if (thrown instanceof z.ZodError)
      return reply.code(400).send({ error: { code: 'validation_error', issues: thrown.issues } });
    return reply
      .code(thrown.statusCode ?? 500)
      .send({ error: { code: thrown.code ?? 'internal_error', message: thrown.message } });
  });
  // The real API authenticates everything but the two third-party paths; so does this.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (
      path.startsWith('/v1/human-queue/callbacks/') ||
      path.startsWith('/v1/human-queue/context/')
    )
      return;
    if (request.headers['x-anonymous'] === '1')
      return reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Authentication required' } });
  });
  registerHumanQueue({
    app,
    store: store as never,
    requireRole: (request: FastifyRequest, role) => {
      const held = (request.headers['x-role'] ?? 'admin') as Role;
      if (RANK[held] < RANK[role as Role])
        throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'forbidden' });
      return {
        identityId: String(request.headers['x-user'] ?? 'admin1'),
        label: 'Tester',
        workspaceId: WORKSPACE,
        role: held,
      };
    },
    expectedVersion: (request) => {
      const value = request.headers['if-match'];
      if (typeof value !== 'string')
        throw Object.assign(new Error('If-Match is required'), {
          statusCode: 428,
          code: 'precondition_required',
        });
      return Number(value.replaceAll('"', ''));
    },
    operations: options.noOperations
      ? undefined
      : ({
          organizationId: WORKSPACE,
          humanQueues: service,
          routing: { points: { get: async (id: string) => options.points?.[id] } },
        } as never),
    flags: { enabled: options.enabled ?? true, webhookEnabled: options.webhookEnabled ?? true },
    rooms: rooms?.room,
    roomTokenTtlSeconds: options.tokenTtlSeconds ?? 120,
    presenceTtlSeconds: 30,
    callbackBaseUrl: 'https://ovo.example.test',
    users: options.users ? ({ list: async () => options.users } as never) : undefined,
    secrets: {
      resolve: async () => secret(),
      forAgent: () => ({ resolve: async () => secret() }),
    } as never,
    outcomes: { available: true, open: async () => outcomes },
    egress,
    now,
    sse: options.sse ?? { pollMs: 20, heartbeatMs: 10_000 },
  });
  const call: HqApp['call'] = (method, url, { payload, user, role, headers } = {}) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: {
        ...(user ? { 'x-user': user } : {}),
        ...(role ? { 'x-role': role } : {}),
        ...headers,
      },
    });
  return { app, service, rooms, egress, outcomes, store, audits: store.audits, now, call };
}

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
