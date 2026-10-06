import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';
import {
  operationsApiSchemas as schemas,
  operationsPage,
  operationsRequestError,
  normalizePhoneNumber,
  publicHandoff,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import type { Principal } from '../types.ts';
import type { InboundReadinessReport } from '../inbound-readiness.ts';
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
  inboundReadiness?: () => Promise<InboundReadinessReport | null>;
}

export function registerOperationsRealtimeRoutes(input: RealtimeRouteDependencies): void {
  const { app, store, requireRole, use, audit } = input;
  registerOperationsInboundRouteManagement(input);

  app.patch('/v1/operations/campaigns/:campaignId', async (request, reply) => {
    const principal = requireRole(request, 'editor');
    const operations = use(reply, principal);
    if (!operations) return;
    const { campaignId } = schemas.campaignParams.parse(request.params);
    const body = schemas.campaignConcurrency.parse(request.body);
    const result = await operations.campaigns
      .patchConcurrency(campaignId, body.expectedVersion, body.maxConcurrency)
      .catch((error: unknown) => {
        if ((error as Error).message === 'Campaign not found')
          return operationsRequestError(404, 'campaign_not_found', 'Campaign not found');
        throw error;
      });
    if (result.kind === 'conflict')
      return reply.code(409).send({
        error: { code: 'campaign_conflict', message: 'Campaign state changed' },
        current: result.campaign,
      });
    await audit(principal, 'operations.campaign.concurrency.update', 'campaign', campaignId, {
      version: result.campaign.version,
      maxConcurrency: result.campaign.maxConcurrency,
    });
    return result.campaign;
  });

  app.post('/v1/operations/contacts/:contactId/redrive', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const operations = use(reply, principal);
    if (!operations) return;
    if (!operations.config.liveEnabled)
      return operationsRequestError(503, 'live_calls_disabled', 'Live calling is not enabled');
    const { contactId } = schemas.redriveParams.parse(request.params);
    const { notBefore } = schemas.redrive.parse(request.body);
    const result = await operations.retries
      .redrive(contactId, new Date(notBefore ?? Date.now()))
      .catch((error: unknown) => {
        if ((error as Error).message === 'Campaign contact not found')
          return operationsRequestError(404, 'campaign_contact_not_found', 'Contact not found');
        throw error;
      });
    if (result.kind === 'blocked')
      return reply.code(409).send({
        error: { code: 'campaign_redrive_blocked', message: 'Contact cannot be redriven' },
        reason: result.reason,
      });
    await audit(principal, 'operations.campaign.contact.redrive', 'campaign-contact', contactId, {
      notBefore: notBefore ?? null,
    });
    return reply.code(202).send(result);
  });

  app.get('/v1/operations/suppressions', async (request, reply) => {
    const query = schemas.suppressionPage.parse(request.query);
    const operations = use(reply, requireRole(request, 'viewer'));
    if (!operations) return;
    return operationsPage(
      await operations.campaigns.listSuppressions(query.limit, query.cursor),
      query.limit,
    );
  });

  app.post('/v1/operations/suppressions', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.suppression.parse(request.body);
    await operations.campaigns.suppress(body.phoneNumber, body.reason);
    const resourceId = createHash('sha256')
      .update(normalizePhoneNumber(body.phoneNumber))
      .digest('hex');
    await audit(principal, 'operations.suppression.upsert', 'suppression', resourceId);
    return reply.code(204).send();
  });

  app.delete('/v1/operations/suppressions/:phoneNumber', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      operations = use(reply, principal);
    if (!operations) return;
    const { phoneNumber } = schemas.suppressionParams.parse(request.params);
    const removed = await operations.campaigns.unsuppress(phoneNumber);
    if (!removed)
      return operationsRequestError(404, 'suppression_not_found', 'Suppression not found');
    await audit(
      principal,
      'operations.suppression.delete',
      'suppression',
      createHash('sha256').update(phoneNumber).digest('hex'),
    );
    return reply.code(204).send();
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
