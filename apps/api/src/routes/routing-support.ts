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
import type { Principal } from '../types.ts';
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
  /** The worker refuses a call whose release has no cost policy when a ledger runs. */
  requireCostPolicy: boolean;
  /** The installed plugins, to read the meters a release's pins emit. */
  registry: PluginRegistry;
  ledger?: Pick<CostLedgerService, 'getPriceCard'>;
  expectedVersion: (request: FastifyRequest) => number;
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
) {
  const query = operationsApiSchemas.uuidPage.parse(request.query);
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
