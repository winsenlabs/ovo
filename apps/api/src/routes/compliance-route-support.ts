import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@winsendotai/ovo-plugin-storage';
import { operationsRequestError, type OperationsService } from '@winsendotai/ovo-plugin-operations';
import type { Principal } from '../types.ts';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

export interface ComplianceRouteContext {
  request: FastifyRequest;
  reply: FastifyReply;
  principal: Principal;
  operations: OperationsService;
}

/**
 * Registers a compliance route that runs only for a caller with `role` on an installation with
 * operations configured; the handler gets the caller and the service.
 */
export function complianceRoutes(input: RealtimeRouteDependencies) {
  return (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    role: Role,
    handler: (context: ComplianceRouteContext) => Promise<unknown>,
  ) =>
    input.app[method](path, async (request, reply) => {
      const principal = input.requireRole(request, role);
      const operations = input.use(reply, principal);
      if (!operations) return;
      return handler({ request, reply, principal, operations });
    });
}

/** Turns a service's "X not found" error into the route's 404; anything else is rethrown. */
export function notFoundAs(code: string, message: string) {
  return (error: unknown): never => {
    if ((error as Error).message === message) return operationsRequestError(404, code, message);
    throw error;
  };
}
