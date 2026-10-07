import {
  normalizePhoneNumber,
  operationsApiSchemas as schemas,
  operationsRequestError,
} from '@winsendotai/ovo-plugin-operations';
import { resolveCampaignCarrier } from '../operations-plugin.ts';
import {
  campaignCompliance,
  campaignPolicy,
  contactVariableErrors,
} from '../outbound-compliance.ts';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

/**
 * Campaign create: variables, then the compliance policy (stage E1: category, consent basis,
 * windows that may only narrow, the caller number's series, A2P and intimation), then the
 * carrier. A refused campaign writes no row; an accepted one carries its policy and import report.
 */
export function registerCampaignCreateRoute(input: RealtimeRouteDependencies): void {
  const { app, store, requireRole, use, audit } = input;

  app.post('/v1/operations/campaigns', async (request, reply) => {
    const principal = requireRole(request, 'editor');
    const operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.campaign.parse(request.body);
    const { contacts, releaseId, callingWindow, compliance: block, ...campaignConfig } = body;
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
    const resolved = campaignPolicy(release, {
      callingWindow,
      compliance: block,
      scheduleTimezone: body.schedule.timezone,
    });
    if (!resolved.ok)
      return reply
        .code(resolved.status)
        .send({ error: { code: resolved.code, message: resolved.message } });
    // Stage E1: the policy and the sender are checked before any row is written.
    const checked = await campaignCompliance(
      operations,
      resolved.value.policy,
      fromNumber,
      contacts,
    );
    if (!checked.ok) {
      await audit(principal, 'operations.campaign.compliance_refused', 'release', release.id, {
        code: checked.code,
      });
      return reply.code(checked.status).send({
        error: {
          code: checked.code,
          message: checked.message,
          ...(checked.details ? { details: checked.details } : {}),
        },
      });
    }
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
          callingWindow: resolved.value.campaignWindow,
          variablesSchema: release.config.variables,
          compliance: resolved.value.policy,
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
      category: resolved.value.policy.category ?? null,
    });
    return reply.code(201).send({ ...campaign, complianceReport: checked.value });
  });
}
