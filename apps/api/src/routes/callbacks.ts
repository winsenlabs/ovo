import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CALLBACK_STATUSES,
  PostgresCallbackStore,
  type CallbackStatus,
} from '../callback-store.ts';

/** Opens the store on first use, so an API that never lists callbacks holds no connections. */
export class CallbackService {
  private store?: Promise<PostgresCallbackStore>;

  constructor(private readonly opener?: () => Promise<PostgresCallbackStore>) {}

  get available(): boolean {
    return this.opener !== undefined;
  }

  open(): Promise<PostgresCallbackStore> {
    this.store ??= this.opener!();
    this.store.catch(() => (this.store = undefined));
    return this.store;
  }

  async close(): Promise<void> {
    const store = this.store;
    this.store = undefined;
    if (store) await (await store).close();
  }
}

export function createCallbackService(options: {
  storageAdapter?: string;
  controlDatabaseUrl?: string;
}): CallbackService {
  const connectionString = options.controlDatabaseUrl;
  return new CallbackService(
    options.storageAdapter === 'postgres' && connectionString
      ? () => PostgresCallbackStore.open({ connectionString, maxConnections: 2 })
      : undefined,
  );
}

type Principal = { workspaceId: string; identityId?: string };

export interface CallbackRouteDependencies {
  app: FastifyInstance;
  callbacks: CallbackService;
  requireRole: (request: FastifyRequest, role: 'viewer' | 'admin') => Principal;
  error: (reply: FastifyReply, status: number, code: string, message: string) => unknown;
  audit?: (
    principal: Principal,
    action: string,
    resourceId: string,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
}

const ListQuery = z.object({
  status: z.enum(CALLBACK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .regex(/^[0-9T:.+\-Z]{10,40}\|[0-9a-f-]{36}$/)
    .optional(),
});
const Params = z.object({ id: z.uuid() });

/**
 * Promised callbacks (AGT-15): listed soonest due first, dialled back on the operator's word, and
 * closed as completed or cancelled. A callback is never dialled on its own: a live call is placed
 * through `POST /v1/calls`, with every live-call check it applies (enabled, caller number,
 * variables, carrier), and keeps that call's id.
 */
export function registerCallbackRoutes(dependencies: CallbackRouteDependencies): void {
  const { app, callbacks, requireRole, error } = dependencies;
  const audit = (principal: Principal, action: string, id: string, payload = {}) =>
    dependencies.audit?.(principal, action, id, payload);
  const unavailable = (reply: FastifyReply) =>
    error(reply, 503, 'callbacks_unavailable', 'Callbacks need PostgreSQL storage');

  app.get('/v1/callbacks', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    const query = ListQuery.parse(request.query);
    if (!callbacks.available) return { available: false, items: [], nextCursor: null };
    const store = await callbacks.open();
    await store.sync(principal.workspaceId);
    return { available: true, ...(await store.list(principal.workspaceId, query)) };
  });

  app.get('/v1/callbacks/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer');
    const { id } = Params.parse(request.params);
    if (!callbacks.available) return unavailable(reply);
    const found = await (await callbacks.open()).get(principal.workspaceId, id);
    return found ?? error(reply, 404, 'not_found', 'Callback not found');
  });

  const close = (action: 'cancel' | 'complete', from: CallbackStatus[], to: CallbackStatus) =>
    app.post(
      `/v1/callbacks/:id/${action}`,
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = requireRole(request, 'admin');
        const { id } = Params.parse(request.params);
        if (!callbacks.available) return unavailable(reply);
        const moved = await (
          await callbacks.open()
        ).transition(principal.workspaceId, id, from, to);
        if (!moved) return error(reply, 404, 'not_found', 'Callback not found');
        if (moved === 'conflict')
          return error(reply, 409, 'callback_state_conflict', `Callback cannot be ${to} now`);
        await audit(principal, `callback.${action}`, id);
        return moved;
      },
    );
  // A callback left `dialing` (an API that stopped mid-dial) can still be closed by an operator.
  close('cancel', ['pending', 'dialing'], 'cancelled');
  close('complete', ['pending', 'dialing', 'dialed'], 'completed');

  app.post('/v1/callbacks/:id/dial', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'admin');
    const { id } = Params.parse(request.params);
    if (!callbacks.available) return unavailable(reply);
    const store = await callbacks.open();
    const dial = await store.claimDial(principal.workspaceId, id);
    if (!dial) return error(reply, 404, 'not_found', 'Callback not found');
    if (dial === 'conflict')
      return error(
        reply,
        409,
        'callback_state_conflict',
        'Callback is not pending or is being dialled',
      );
    if (dial === 'unreachable')
      return error(reply, 422, 'callback_unreachable', 'The original call has no number to dial');
    const { operationId, ...body } = dial;
    // The live-call route runs as this operator, so it applies every check a manual call would.
    const placed = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: {
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
      },
      payload: { operationId, ...body },
    });
    if (placed.statusCode !== 202) {
      await store.transition(principal.workspaceId, id, ['dialing'], 'pending');
      return reply.code(placed.statusCode).type('application/json').send(placed.body);
    }
    const callId = (placed.json() as { callId: string }).callId;
    const dialed = await store.transition(principal.workspaceId, id, ['dialing'], 'dialed', callId);
    await audit(principal, 'callback.dial', id, { callId });
    // Closed by an operator while the call was being placed: the call stands, the close is kept.
    return reply
      .code(202)
      .send(dialed === 'conflict' ? await store.get(principal.workspaceId, id) : dialed);
  });
}

/** The routes plus the store they open; closed with the app. */
export function registerCallbacks(dependencies: {
  app: FastifyInstance;
  requireRole: CallbackRouteDependencies['requireRole'];
  error: CallbackRouteDependencies['error'];
  store?: { audit(entry: Record<string, unknown>): Promise<unknown> };
  options?: Parameters<typeof createCallbackService>[0];
}): CallbackService {
  const callbacks = createCallbackService(dependencies.options ?? {});
  dependencies.app.addHook('onClose', () => callbacks.close());
  const store = dependencies.store;
  registerCallbackRoutes({
    app: dependencies.app,
    callbacks,
    requireRole: dependencies.requireRole,
    error: dependencies.error,
    ...(store
      ? {
          audit: (principal, action, resourceId, payload) =>
            store.audit({
              workspaceId: principal.workspaceId,
              actorId: principal.identityId,
              action,
              resourceType: 'callback',
              resourceId,
              payload,
            }),
        }
      : {}),
  });
  return callbacks;
}
