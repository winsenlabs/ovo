import { createHash } from 'node:crypto';
import {
  DoNotCallLockedError,
  normalizePhoneNumber,
  operationsApiSchemas as schemas,
  operationsPage,
  operationsRequestError,
} from '@winsendotai/ovo-plugin-operations';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

/** The do-not-call list: page through it, add a number, and remove one (admin, with a reason). */
export function registerOperationsSuppressionRoutes(input: RealtimeRouteDependencies): void {
  const { app, requireRole, use, audit } = input;

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

  // Removing a do-not-call entry is an admin action with a stated reason, and an opt-out inside
  // its 90-day lock cannot be removed at all (TCCCPR R13). Every removal is audited.
  app.delete('/v1/operations/suppressions/:phoneNumber', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      operations = use(reply, principal);
    if (!operations) return;
    const { phoneNumber } = schemas.suppressionParams.parse(request.params);
    const { reason } = schemas.suppressionDelete.parse(request.query);
    const resourceId = createHash('sha256').update(phoneNumber).digest('hex');
    let removed;
    try {
      removed = await operations.campaigns.doNotCall.remove(phoneNumber);
    } catch (error) {
      if (!(error instanceof DoNotCallLockedError)) throw error;
      await audit(principal, 'operations.suppression.delete_refused', 'suppression', resourceId, {
        reason,
        lockUntil: error.lockUntil.toISOString(),
      });
      return reply.code(409).send({
        error: {
          code: 'opt_out_locked',
          message: error.message,
          details: { lockUntil: error.lockUntil.toISOString() },
        },
      });
    }
    if (!removed)
      return operationsRequestError(404, 'suppression_not_found', 'Suppression not found');
    await audit(principal, 'operations.suppression.delete', 'suppression', resourceId, {
      reason,
      source: removed.source,
      scope: removed.scope,
    });
    return reply.code(204).send();
  });
}
