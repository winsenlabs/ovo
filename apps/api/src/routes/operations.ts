import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';
import {
  normalizePhoneNumber,
  operationsApiSchemas,
  operationsPage,
  operationsRequestError,
  previewCampaignCsv,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import type { Principal } from '../types.ts';
import { resolveCampaignCarrier } from '../operations-plugin.ts';
import type { InfrastructureService } from '../infrastructure-types.ts';
import { registerOperationsRealtimeRoutes } from './operations-realtime.ts';
import type { InboundRouteDependencies } from './operations-inbound-routes.ts';
import { registerOperationsLiveCallRoute } from './operations-live-call.ts';
import { registerOperationsComplianceRoutes } from './operations-compliance.ts';
import { campaignCallingWindow, contactVariableErrors } from '../outbound-compliance.ts';

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
  /** Source of the dispatcher's inbound readiness for the capacity route (OPS-4). */
  infrastructure?: Pick<InfrastructureService, 'inboundReadiness'>;
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
    const operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.preview.parse(request.body);
    const preview = previewCampaignCsv(body.csv, body.mapping);
    const release = body.releaseId
      ? await store.getRelease(principal.workspaceId, body.releaseId)
      : undefined;
    if (body.releaseId && !release)
      return operationsRequestError(404, 'release_not_found', 'Release not found');
    const variableErrors = release ? contactVariableErrors(release, preview.rows) : [];
    const listed = await operations.campaigns.doNotCall.listed(
      preview.rows.map((row) => row.phoneNumber),
    );
    return {
      ...preview,
      errors: [
        ...preview.errors,
        ...variableErrors.map(({ row, errors }) => ({
          row,
          field: 'variables',
          message: errors.join('; '),
        })),
      ],
      // Listed rows import, but admission never dials them.
      doNotCall: preview.rows
        .filter((row) => listed.has(row.phoneNumber))
        .map((row) => row.sourceRow),
    };
  });

  registerOperationsLiveCallRoute({ app, store, requireRole, use, audit });
  registerOperationsComplianceRoutes({ app, store, requireRole, use, audit });

  app.post('/v1/operations/campaigns', async (request, reply) => {
    const principal = requireRole(request, 'editor');
    const operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.campaign.parse(request.body);
    const { contacts, releaseId, callingWindow, ...campaignConfig } = body;
    const release = await store.getRelease(principal.workspaceId, releaseId);
    if (!release) return operationsRequestError(404, 'release_not_found', 'Release not found');
    const fromNumber = normalizePhoneNumber(body.fromNumber);
    if (!operations.config.permittedFromNumbers.includes(fromNumber))
      return operationsRequestError(
        403,
        'from_number_not_permitted',
        'Caller number is not permitted',
      );
    const invalid = contactVariableErrors(release, contacts);
    if (invalid.length)
      return reply.code(422).send({
        error: {
          code: 'invalid_contact_variables',
          message: `${invalid.length} contact${invalid.length === 1 ? '' : 's'} do not satisfy the release variable schema`,
          details: invalid,
        },
      });
    const window = campaignCallingWindow(release, callingWindow, body.schedule.timezone);
    if (!window.ok)
      return reply
        .code(window.status)
        .send({ error: { code: window.code, message: window.message } });
    let carrier;
    try {
      carrier = await resolveCampaignCarrier(operations, release, store);
    } catch (error) {
      return operationsRequestError(422, 'campaign_carrier_unavailable', (error as Error).message);
    }
    let campaign;
    try {
      campaign = await operations.campaigns.create(
        {
          ...campaignConfig,
          ...carrier,
          fromNumber,
          agentReleaseId: release.id,
          callingWindow: window.value,
          variablesSchema: release.config.variables,
        },
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
    const query = schemas.uuidPage.parse(request.query);
    const items = await operations.campaigns.list(query.limit, query.cursor);
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

  // The realtime routes hand their input to the inbound routes, capacity readiness included.
  const realtime: InboundRouteDependencies = {
    app,
    store,
    requireRole,
    use,
    audit,
    inboundReadiness: input.infrastructure?.inboundReadiness?.bind(input.infrastructure),
  };
  registerOperationsRealtimeRoutes(realtime);
}
