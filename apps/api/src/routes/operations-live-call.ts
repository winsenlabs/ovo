import {
  normalizePhoneNumber,
  operationsApiSchemas as schemas,
  operationsRequestError,
  validateReleaseVariables,
} from '@winsendotai/ovo-plugin-operations';
import { resolveCampaignCarrier } from '../operations-plugin.ts';
import { campaignPolicy, manualDialCompliance } from '../outbound-compliance.ts';

/** A manual call's policy: the release's, its window judged at request time only. */
const replay = { scheduleTimezone: 'UTC', manual: true } as const;
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

export function registerOperationsLiveCallRoute(input: RealtimeRouteDependencies): void {
  const { app, store, requireRole, use, audit } = input;
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
    // A retry of a launch already accepted replays its receipt, even if the window closed since.
    const accepted = await store.getCall(principal.workspaceId, body.operationId);
    const replayed = accepted && !body.dryRun ? campaignPolicy(release, replay) : undefined;
    const compliance = replayed?.ok
      ? ({ ok: true, value: { window: null, policy: replayed.value.policy } } as const)
      : await manualDialCompliance(operations, release, body.to, fromNumber);
    if (!compliance.ok)
      return reply.code(compliance.status).send({
        error: {
          code: compliance.code,
          message: compliance.message,
          ...(compliance.details ? { details: compliance.details } : {}),
        },
      });
    let carrier;
    try {
      carrier = await resolveCampaignCarrier(operations, release, store);
    } catch (error) {
      return operationsRequestError(422, 'campaign_carrier_unavailable', (error as Error).message);
    }
    if (body.dryRun)
      return reply.code(200).send({
        dryRun: true,
        releaseId: release.id,
        to: normalizePhoneNumber(body.to),
        fromNumber,
        variables: Object.keys(body.variables).sort(),
        callingWindow: compliance.value.window,
        carrierId: carrier.carrierId,
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
          maxConcurrency: 1,
          ...carrier,
          // Checked above, at request time. Snapshotting it would requeue a call accepted just
          // before the window closed and dial it unasked when the window next opens; the policy
          // is `manual`, so authorization re-checks everything but the window.
          callingWindow: null,
          variablesSchema: release.config.variables,
          compliance: compliance.value.policy,
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
}
