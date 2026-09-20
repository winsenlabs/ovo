import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';
import {
  operationsApiSchemas as schemas,
  operationsPage,
  operationsRequestError,
  publicHandoff,
  type InboundOverflowPolicy,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import type { Principal } from '../types.ts';
import { registerOperationsInboundRouteManagement } from './operations-inbound-routes.ts';

export interface RealtimeRouteDependencies {
  app: FastifyInstance;
  store: ControlStore;
  requireRole: (request: FastifyRequest, role: Role) => Principal;
  use: (reply: FastifyReply, principal: Principal) => OperationsService | undefined;
  audit: (
    principal: Principal,
    action: string,
    resourceType: string,
    resourceId: string,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
}

export function registerOperationsRealtimeRoutes(input: RealtimeRouteDependencies): void {
  const { app, store, requireRole, use, audit } = input;
  registerOperationsInboundRouteManagement(input);

  app.get('/v1/operations/inbound/policy', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    return { policy: await operations.inbound.getPolicy() };
  });

  app.put('/v1/operations/inbound/policy', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.inboundPolicy.parse(request.body);
    const policy = await operations.inbound.setPolicy(
      body.policy as InboundOverflowPolicy,
      body.expectedVersion,
    );
    if (!policy)
      return reply.code(409).send({
        error: { code: 'inbound_policy_conflict', message: 'Inbound policy state changed' },
        current: await operations.inbound.getPolicy(),
      });
    await audit(principal, 'operations.inbound.policy.update', 'inbound_policy', 'default', {
      version: policy.version,
      kind: policy.policy.kind,
    });
    return policy;
  });

  app.get('/v1/operations/inbound/capacity', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    return { readyProtected: await operations.inbound.readyProtectedCapacity() };
  });

  app.get('/v1/operations/inbound/decisions', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    const query = schemas.uuidPage.parse(request.query),
      items = await operations.inbound.listDecisions(query.limit, query.cursor);
    return operationsPage(items, query.limit);
  });

  app.post('/v1/operations/inbound/decisions', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      operations = use(reply, principal);
    if (!operations) return;
    const { callId } = schemas.inboundDecision.parse(request.body);
    let decision;
    try {
      decision = await operations.inbound.admitUsingPolicy(callId);
    } catch (error) {
      if ((error as Error).message.includes('not configured'))
        return operationsRequestError(
          409,
          'inbound_policy_missing',
          'Inbound policy is not configured',
        );
      throw error;
    }
    await audit(principal, 'operations.inbound.decide', 'inbound_call', callId, {
      decision: decision.kind,
    });
    return reply.code(201).send(decision);
  });

  app.post('/v1/operations/handoffs', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.handoff.parse(request.body);
    if (!operations.handoffs.available)
      return void reply.code(503).send({
        error: {
          code: 'handoff_unavailable',
          message: 'Carrier handoff is not configured',
        },
      });
    const { callId, ...handoffInput } = body;
    const call = await store.getCall(principal.workspaceId, callId);
    if (!call || call.kind !== 'live')
      return operationsRequestError(404, 'live_call_not_found', 'Live call not found');
    if (call.completedAt)
      return operationsRequestError(409, 'call_terminal', 'Call is already terminal');
    const binding = await operations.calls.get(call.id);
    if (!binding || binding.status !== 'active' || binding.releaseId !== call.releaseId)
      return operationsRequestError(
        409,
        'call_binding_unavailable',
        'Verified carrier call binding is unavailable',
      );
    let handoff;
    try {
      handoff = await operations.handoffs.request({
        ...handoffInput,
        sessionId: call.id,
        carrierCallId: binding.carrierCallId,
      });
    } catch (error) {
      if ((error as Error).message.includes('operationId collision'))
        return operationsRequestError(
          409,
          'operation_id_collision',
          'Handoff operation ID was already used with different input',
        );
      throw error;
    }
    if (handoff.status === 'ready') handoff = await operations.handoffs.execute(handoff.id);
    await audit(principal, 'operations.handoff.request', 'handoff', handoff.id, {
      callId: call.id,
      status: handoff.status,
    });
    return reply
      .code(handoff.status === 'awaiting_confirmation' ? 202 : 201)
      .send(publicHandoff(handoff));
  });

  app.get('/v1/operations/handoffs/:handoffId', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      operations = use(reply, principal);
    if (!operations) return;
    const { handoffId } = schemas.handoffParams.parse(request.params);
    const handoff = await operations.handoffs.get(handoffId).catch((error: unknown) => {
      if ((error as Error).message === 'Handoff not found')
        return operationsRequestError(404, 'handoff_not_found', 'Handoff not found');
      throw error;
    });
    if (!(await store.getCall(principal.workspaceId, handoff.sessionId)))
      return operationsRequestError(404, 'handoff_not_found', 'Handoff not found');
    return publicHandoff(handoff);
  });

  app.post('/v1/operations/handoffs/:handoffId/confirm', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      operations = use(reply, principal);
    if (!operations) return;
    const { handoffId } = schemas.handoffParams.parse(request.params);
    const { accepted } = schemas.handoffConfirmation.parse(request.body);
    if (accepted && !operations.handoffs.available)
      return void reply.code(503).send({
        error: {
          code: 'handoff_unavailable',
          message: 'Carrier handoff is not configured',
        },
      });
    const current = await operations.handoffs.get(handoffId).catch(() => undefined);
    if (!current || !(await store.getCall(principal.workspaceId, current.sessionId)))
      return operationsRequestError(404, 'handoff_not_found', 'Handoff not found');
    let handoff = await operations.handoffs.confirm(handoffId, accepted);
    if (handoff.status === 'ready') handoff = await operations.handoffs.execute(handoff.id);
    await audit(principal, 'operations.handoff.confirm', 'handoff', handoff.id, {
      accepted,
      status: handoff.status,
    });
    return publicHandoff(handoff);
  });
}
