import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';
import {
  normalizePhoneNumber,
  operationsApiSchemas,
  operationsPage,
  operationsRequestError,
  previewCampaignCsv,
  validateReleaseVariables,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import type { Principal } from '../types.ts';
import { registerOperationsRealtimeRoutes } from './operations-realtime.ts';

const schemas = operationsApiSchemas;

function serviceOr503(
  operations: OperationsService | undefined,
  reply: FastifyReply,
  workspaceId: string,
) {
  if (!operations)
    return void reply.code(503).send({
      error: { code: 'operations_unavailable', message: 'Operations service is not configured' },
    });
  if (operations.organizationId !== workspaceId)
    return void reply.code(403).send({
      error: {
        code: 'operations_scope_mismatch',
        message: 'Operations service is not configured for this workspace',
      },
    });
  return operations;
}

export interface OperationsRouteDependencies {
  app: FastifyInstance;
  operations?: OperationsService;
  store: ControlStore;
  requireRole: (request: FastifyRequest, role: Role) => Principal;
}

export function registerOperationsRoutes(input: OperationsRouteDependencies): void {
  const { app, store, requireRole } = input;
  const use = (reply: FastifyReply, principal: Principal) =>
    serviceOr503(input.operations, reply, principal.workspaceId);
  const audit = (
    principal: Principal,
    action: string,
    resourceType: string,
    resourceId: string,
    payload?: Record<string, unknown>,
  ) =>
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action,
      resourceType,
      resourceId,
      payload,
    });

  app.post('/v1/operations/campaigns/preview', async (request, reply) => {
    const principal = requireRole(request, 'editor');
    if (!use(reply, principal)) return;
    const body = schemas.preview.parse(request.body);
    return previewCampaignCsv(body.csv, body.mapping);
  });

  app.post('/v1/calls', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      operations = use(reply, principal);
    if (!operations) return;
    if (operations.config.liveEnabled !== true)
      return void reply.code(503).send({
        error: {
          code: 'live_calls_disabled',
          message: 'Live calling is not enabled for this installation',
        },
      });
    const body = schemas.liveCall.parse(request.body);
    const release = await store.getRelease(principal.workspaceId, body.releaseId);
    if (!release) return operationsRequestError(404, 'release_not_found', 'Release not found');
    const fromNumber = normalizePhoneNumber(body.fromNumber);
    if (!operations.config.permittedFromNumbers.includes(fromNumber))
      return operationsRequestError(
        403,
        'from_number_not_permitted',
        'Caller number is not permitted',
      );
    const variableValidation = validateReleaseVariables(release.config.variables, body.variables);
    if (!variableValidation.valid)
      return reply.code(422).send({
        error: {
          code: 'invalid_call_variables',
          message: 'Call variables do not satisfy the release schema',
          details: variableValidation.errors,
        },
      });
    let campaign;
    try {
      campaign = await operations.campaigns.create(
        {
          operationId: body.operationId,
          name: `Live call ${body.operationId}`,
          agentReleaseId: release.id,
          fromNumber,
          schedule: { localDateTime: '2000-01-01T00:00', timezone: 'UTC' },
          perNumberAttemptLimit: 1,
          maxAttemptsTotal: 1,
          maxAttemptsPerLocalDay: 1,
          activeCallPolicy: 'continue',
        },
        [{ sourceRow: 1, phoneNumber: body.to, variables: body.variables }],
      );
    } catch (error) {
      if ((error as Error).message.includes('operationId collision'))
        return operationsRequestError(
          409,
          'operation_id_collision',
          'Live call operation ID was already used with different input',
        );
      throw error;
    }
    let call = await store.getCall(principal.workspaceId, body.operationId);
    if (call && (call.kind !== 'live' || call.releaseId !== release.id))
      return operationsRequestError(
        409,
        'operation_id_collision',
        'Live call operation ID is already in use',
      );
    if (!call) {
      try {
        call = await store.createCall({
          id: body.operationId,
          workspaceId: principal.workspaceId,
          releaseId: release.id,
          kind: 'live',
          status: 'queued',
        });
      } catch (error) {
        const raced = await store.getCall(principal.workspaceId, body.operationId);
        if (!raced || raced.kind !== 'live' || raced.releaseId !== release.id) throw error;
        call = raced;
      }
    }
    const admission = await operations.campaigns.admit(
      campaign.id,
      `api-live:${body.operationId}`,
      300_000,
      body.operationId,
    );
    let contactId: string;
    if (admission.kind === 'admitted') {
      contactId = admission.contactId;
      await store.appendCallEvent(principal.workspaceId, body.operationId, 'live.queued', {
        campaignId: campaign.id,
        contactId,
        jobId: body.operationId,
      });
    } else {
      const queued = await operations.outbox.getByJobId(body.operationId);
      const queuedContactId = queued?.payload.contactId;
      if (typeof queuedContactId !== 'string') {
        await store.finishCall(principal.workspaceId, body.operationId, 'blocked');
        return reply.code(409).send({
          error: { code: 'live_call_blocked', message: 'Live call was not admitted' },
          callId: body.operationId,
        });
      }
      contactId = queuedContactId;
    }
    await audit(principal, 'operations.live_call.launch', 'call', body.operationId, {
      campaignId: campaign.id,
      contactId,
      jobId: body.operationId,
      releaseId: release.id,
    });
    return reply.code(202).send({
      callId: body.operationId,
      jobId: body.operationId,
      campaignId: campaign.id,
      contactId,
      status: call.status,
    });
  });

  app.post('/v1/operations/campaigns', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.campaign.parse(request.body);
    const { contacts, releaseId, ...campaignConfig } = body;
    const release = await store.getRelease(principal.workspaceId, releaseId);
    if (!release) return operationsRequestError(404, 'release_not_found', 'Release not found');
    const fromNumber = normalizePhoneNumber(body.fromNumber);
    if (!operations.config.permittedFromNumbers.includes(fromNumber))
      return operationsRequestError(
        403,
        'from_number_not_permitted',
        'Caller number is not permitted',
      );
    let campaign;
    try {
      campaign = await operations.campaigns.create(
        { ...campaignConfig, fromNumber, agentReleaseId: release.id },
        contacts,
      );
    } catch (error) {
      if ((error as Error).message.includes('operationId collision'))
        return operationsRequestError(
          409,
          'operation_id_collision',
          'Campaign operation ID was already used with different input',
        );
      throw error;
    }
    await audit(principal, 'operations.campaign.create', 'campaign', campaign.id, {
      releaseId: release.id,
    });
    return reply.code(201).send(campaign);
  });

  app.get('/v1/operations/campaigns', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    const query = schemas.uuidPage.parse(request.query),
      items = await operations.campaigns.list(query.limit, query.cursor);
    return operationsPage(items, query.limit);
  });

  app.get('/v1/operations/campaigns/:campaignId', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    const { campaignId } = schemas.campaignParams.parse(request.params);
    try {
      return {
        campaign: await operations.campaigns.get(campaignId),
        counters: await operations.campaigns.counters(campaignId),
      };
    } catch (error) {
      if ((error as Error).message === 'Campaign not found')
        return operationsRequestError(404, 'campaign_not_found', 'Campaign not found');
      throw error;
    }
  });

  for (const command of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/v1/operations/campaigns/:campaignId/${command}`, async (request, reply) => {
      const principal = requireRole(request, 'editor'),
        operations = use(reply, principal);
      if (!operations) return;
      const { campaignId } = schemas.campaignParams.parse(request.params);
      const { expectedVersion } = schemas.campaignCommand.parse(request.body);
      const result = await operations.campaigns
        .command(campaignId, command, expectedVersion)
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
      await audit(principal, `operations.campaign.${command}`, 'campaign', campaignId, {
        version: result.campaign.version,
      });
      return result.campaign;
    });
  }

  app.get('/v1/operations/suppressions', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    const query = schemas.suppressionPage.parse(request.query),
      items = await operations.campaigns.listSuppressions(query.limit, query.cursor);
    return operationsPage(items, query.limit);
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

  registerOperationsRealtimeRoutes({ app, store, requireRole, use, audit });
}
