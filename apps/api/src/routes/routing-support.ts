import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  operationsApiSchemas,
  operationsPage,
  type OperationsService,
  type RoutingService,
} from '@winsendotai/ovo-plugin-operations';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import type { RateLimiter } from '../human-queue-ports.ts';
import type { LiveEngineFactory, RoutingSimulator } from '../routing-simulator.ts';
import type { Principal } from '../types.ts';
import type { CallOutcomeReader } from './call-outcomes.ts';
import { serviceOr503 } from './operations.ts';

/** What the `/v1/routing/*` routes need (Wave 15, design section 6). */
export interface RoutingRouteDependencies {
  app: FastifyInstance;
  store: ControlStore;
  requireRole: (request: FastifyRequest, role: Role) => Principal;
  operations?: OperationsService;
  /** `OVO_ROUTING_ENABLED`; off, every route but `status` answers 404 `routing_disabled`. */
  enabled: boolean;
  /** `OVO_ROUTING_EXTERNAL_ENABLED`; off, publish warns that external engines will not call out. */
  externalEnabled: boolean;
  /** `OVO_ROUTING_TRANSFER_ENABLED`; off, publish warns that a transfer catalogue stays inert. */
  transferEnabled: boolean;
  /** `OVO_HUMAN_QUEUE_ENABLED`; reported by `status`, and a bound queue warns while it is off. */
  humanQueueEnabled?: boolean;
  /** `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED`; off, a bound webhook queue warns that it stays inert. */
  humanQueueWebhookEnabled?: boolean;
  /** A `Cap.mediaRoom` provider is composed here; absent, a bound desk queue warns. */
  roomConfigured?: boolean;
  /** The worker refuses a call whose release has no cost policy when a ledger runs. */
  requireCostPolicy: boolean;
  /** The installed plugins, to read the meters a release's pins emit. */
  registry: PluginRegistry;
  ledger?: Pick<CostLedgerService, 'getPriceCard'>;
  expectedVersion: (request: FastifyRequest) => number;
  /** R4: call outcomes, for stats and for `outcomesAvailable`; absent, both read as not stored. */
  outcomes?: Pick<CallOutcomeReader, 'available' | 'open'>;
  /** R4: the router's simulator, pool explainer and scorer; absent, those routes answer 503. */
  simulator?: RoutingSimulator;
  /** `OVO_ROUTING_SIMULATE_LIVE_ENABLED`: admins may run the decision and LLM engines for real. */
  simulateLiveEnabled?: boolean;
  /** Real engines for a live request (needs the flags above and `externalEnabled` for external). */
  liveEngines?: LiveEngineFactory;
  /** `OVO_ROUTING_SIMULATE_RATE_PER_MINUTE`: simulations and eval runs per identity per minute (30). */
  simulateRatePerMinute?: number;
  /** Test seam: the clock simulations read when a request sets none, and the rate limiter's. */
  clock?: () => number;
}

/** The limiter and audit every R4 write route shares (built once by `registerRoutingRoutes`). */
export interface RoutingR4Dependencies extends RoutingRouteDependencies {
  audit: RoutingAudit;
  limiter: RateLimiter;
}

export type RoutingAudit = (
  principal: Principal,
  action: string,
  resourceType: string,
  resourceId: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

export const etag = (version: number) => `"${version}"`;

export function routingAudit(store: ControlStore): RoutingAudit {
  return (principal, action, resourceType, resourceId, payload) =>
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action,
      resourceType,
      resourceId,
      payload,
    });
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return reply.code(status).send({ error: { code, message }, ...extra });
}

/**
 * The routing service for this principal, or the reply already sent: 404 `routing_disabled` while
 * the flag is off (checked first, so a dark installation never says more), then the operations
 * service's own 503/403.
 */
export function routingOr404(
  input: Pick<RoutingRouteDependencies, 'enabled' | 'operations'>,
  reply: FastifyReply,
  principal: Principal,
): RoutingService | undefined {
  if (!input.enabled)
    return void sendError(reply, 404, 'routing_disabled', 'Routing is not enabled');
  return serviceOr503(input.operations, reply, principal.workspaceId)?.routing;
}

/** A phone number shown in a refusal: only its last four digits. */
export const maskNumber = (value: string) => `••••${value.slice(-4)}`;

export interface RoutingCall {
  request: FastifyRequest;
  reply: FastifyReply;
  principal: Principal;
  routing: RoutingService;
}

/** A `/v1/routing/*` handler behind its role check and the dark switch. */
export function routed(
  input: Pick<RoutingRouteDependencies, 'requireRole' | 'enabled' | 'operations'>,
  role: Role,
  handler: (call: RoutingCall) => unknown,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = input.requireRole(request, role);
    const routing = routingOr404(input, reply, principal);
    if (!routing) return;
    return handler({ request, reply, principal, routing });
  };
}

/** One page of a routing list, with the cursor every operations list uses (the last id). */
export async function routingPage<T extends { id: string }>(
  request: FastifyRequest,
  list: (limit: number, cursor?: string) => Promise<T[]>,
  /** Query keys the route reads itself (`include`, `view`), which the page schema must not see. */
  omit: readonly string[] = [],
) {
  const rest = Object.fromEntries(
    Object.entries((request.query ?? {}) as Record<string, unknown>).filter(
      ([key]) => !omit.includes(key),
    ),
  );
  const query = operationsApiSchemas.uuidPage.parse(rest);
  return operationsPage(await list(query.limit, query.cursor), query.limit);
}

/** A 409 for a stale etag, with the row as it is now (null once it is gone). */
export async function staleConflict(
  reply: FastifyReply,
  code: string,
  message: string,
  current: Promise<unknown>,
) {
  return sendError(reply, 409, code, message, { current: (await current) ?? null });
}

/**
 * Takes one hit of the workspace identity's allowance, or sends the 429 and says so. Shared by the
 * simulator and the eval runs, which can both cost the API real work.
 */
export function withinRate(
  reply: FastifyReply,
  limiter: RateLimiter,
  principal: Principal,
): boolean {
  const key = `${principal.workspaceId}:${principal.identityId}`;
  if (limiter.take(key)) return true;
  reply.header('retry-after', String(Math.max(1, limiter.retryAfterSeconds(key))));
  sendError(reply, 429, 'rate_limited', 'Too many simulations; try again shortly');
  return false;
}
