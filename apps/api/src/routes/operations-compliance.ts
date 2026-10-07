import { createHash } from 'node:crypto';
import {
  normalizePhoneNumber,
  operationsApiSchemas as schemas,
  operationsRequestError,
} from '@winsendotai/ovo-plugin-operations';
import { registerComplianceConfigRoutes } from './compliance-config.ts';
import { registerComplianceEvidenceRoutes } from './compliance-evidence.ts';
import { registerComplianceRecordRoutes } from './compliance-records.ts';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

/**
 * Do-not-call lookups and bulk import, and a campaign's contacts for the console's test call.
 * Phone numbers never reach the audit log: entries are keyed by a hash of the number.
 */
export function registerOperationsComplianceRoutes(input: RealtimeRouteDependencies): void {
  const { app, requireRole, use, audit } = input;
  registerComplianceConfigRoutes(input);
  registerComplianceRecordRoutes(input);
  registerComplianceEvidenceRoutes(input);

  app.get('/v1/operations/suppressions/:phoneNumber', async (request, reply) => {
    const operations = use(reply, requireRole(request, 'viewer'));
    if (!operations) return;
    const { phoneNumber } = schemas.suppressionParams.parse(request.params);
    const entry = await operations.campaigns.doNotCall.get(phoneNumber);
    if (!entry)
      return operationsRequestError(404, 'suppression_not_found', 'Number is not on the list');
    return entry;
  });

  app.post('/v1/operations/suppressions/import', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.doNotCallImport.parse(request.body);
    const invalid = body.entries.flatMap((entry, index) => {
      try {
        normalizePhoneNumber(entry.phoneNumber);
        return [];
      } catch {
        return [index + 1];
      }
    });
    if (invalid.length)
      return reply.code(422).send({
        error: {
          code: 'invalid_phone_numbers',
          message: 'Every number must be E.164',
          details: { entries: invalid.slice(0, 100) },
        },
      });
    const result = await operations.campaigns.doNotCall.import(body.entries);
    const digest = createHash('sha256')
      .update(
        body.entries
          .map((entry) => normalizePhoneNumber(entry.phoneNumber))
          .sort()
          .join(','),
      )
      .digest('hex');
    await audit(principal, 'operations.suppression.import', 'suppression', digest, result);
    return reply.code(200).send(result);
  });

  app.get('/v1/operations/campaigns/:campaignId/contacts', async (request, reply) => {
    // Contacts carry caller data (names, amounts), so viewers do not see them.
    const operations = use(reply, requireRole(request, 'editor'));
    if (!operations) return;
    const { campaignId } = schemas.campaignParams.parse(request.params);
    const query = schemas.contactPage.parse(request.query);
    try {
      const items = await operations.campaigns.listContacts(campaignId, query.limit, query.cursor);
      return {
        items,
        nextCursor: items.length === query.limit ? items.at(-1)!.sourceRow : null,
      };
    } catch (error) {
      if ((error as Error).message === 'Campaign not found')
        return operationsRequestError(404, 'campaign_not_found', 'Campaign not found');
      throw error;
    }
  });
}
