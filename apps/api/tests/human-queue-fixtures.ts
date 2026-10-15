import { afterEach } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MediaRoomProvider } from '@winsendotai/ovo-contracts';
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

/**
 * What these tests use of a room server beyond the provider contract: the conformance fake's
 * hooks. Tests pass `fakeMediaRoom` in (`makeRoom`); this file cannot import the conformance kit
 * itself, since only test files may.
 */
export interface TestRoom extends MediaRoomProvider {
  readonly room: MediaRoomProvider;
  claimsOf(token: string): Promise<{
    room: string;
    identity: string;
    name?: string;
    issuedAtMs: number;
    expiresAtMs: number;
  }>;
  connect(input: {
    token: string;
    room: string;
    format: never;
  }): Promise<{ connected: boolean; close(): Promise<void> }>;
  roomNames(): string[];
  setHealthy(healthy: boolean): void;
}

export interface HqApp {
  app: ReturnType<typeof Fastify>;
  service: InMemoryHumanQueueService;
  rooms?: TestRoom;
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
  /** Makes the room server (the conformance fake); absent or `noRooms`, none is composed. */
  makeRoom?: () => TestRoom;
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
  /** `OVO_ROOM_TOKEN_TTL_SECONDS`. */
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
  const rooms = options.noRooms ? undefined : options.makeRoom?.();
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

/**
 * An app factory for one test file: apps it makes are closed after each test, and each gets the
 * room server `makeRoom` builds (the conformance fake, which only a test file may import).
 */
export function useHq(makeRoom: () => TestRoom) {
  const apps: HqApp[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((hq) => hq.app.close())));
  return (options: HqAppOptions = {}) => {
    const built = humanQueueApp({ makeRoom, ...options });
    apps.push(built);
    return built;
  };
}
