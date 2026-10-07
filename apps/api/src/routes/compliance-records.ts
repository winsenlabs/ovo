import { createHash } from 'node:crypto';
import {
  ConsentRejected,
  normalizePhoneNumber,
  operationsApiSchemas as schemas,
  operationsRequestError,
} from '@winsendotai/ovo-plugin-operations';
import { complianceRoutes, notFoundAs } from './compliance-route-support.ts';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

const digest = (value: string) =>
  createHash('sha256').update(normalizePhoneNumber(value)).digest('hex');

/**
 * Consent records, DND scrub uploads and complaints. They carry callers' numbers, so viewers see
 * none of them; the audit log keys every change by a hash of the number, never the number.
 */
export function registerComplianceRecordRoutes(input: RealtimeRouteDependencies): void {
  const on = complianceRoutes(input);
  const { audit } = input;

  on('get', '/v1/operations/compliance/consents', 'editor', async ({ request, operations }) => ({
    items: await operations.compliance.consents.list(
      schemas.phoneQuery.parse(request.query).phoneNumber,
    ),
  }));

  on('post', '/v1/operations/compliance/consents', 'editor', async (context) => {
    const body = schemas.consent.parse(context.request.body);
    let saved;
    try {
      saved = await context.operations.compliance.consents.record({
        ...body,
        obtainedAt: new Date(body.obtainedAt),
      });
    } catch (error) {
      if (!(error instanceof ConsentRejected)) throw error;
      const status = error.code === 'opt_out_locked' ? 409 : 422;
      return operationsRequestError(status, error.code, error.message);
    }
    await audit(context.principal, 'operations.compliance.consent.record', 'consent', saved.id, {
      phone: digest(saved.phoneNumber),
      category: saved.category,
      basis: saved.basis,
    });
    return context.reply.code(201).send(saved);
  });

  on('post', '/v1/operations/compliance/consents/:id/revoke', 'editor', async (context) => {
    const { id } = schemas.idParams.parse(context.request.params);
    const body = schemas.consentRevoke.parse(context.request.body);
    const revoked = await context.operations.compliance.consents
      .revoke(id, body.source, body.ref)
      .catch(notFoundAs('consent_not_found', 'Consent not found'));
    await audit(context.principal, 'operations.compliance.consent.revoke', 'consent', id, {
      source: body.source,
    });
    return revoked;
  });

  on('post', '/v1/operations/compliance/preferences/upload', 'editor', async (context) => {
    const body = schemas.preferenceUpload.parse(context.request.body);
    const rows = body.rows.map(({ checkedAt, ...row }) => ({
      ...row,
      ...(checkedAt ? { checkedAt: new Date(checkedAt) } : {}),
    }));
    const result = await context.operations.compliance.preferences.upload(rows, body.provider);
    const action = 'operations.compliance.preferences.upload';
    await audit(context.principal, action, 'preference-checks', body.provider, result);
    return result;
  });

  on('get', '/v1/operations/compliance/preferences/:phoneNumber', 'editor', async (context) => {
    const { phoneNumber } = schemas.suppressionParams.parse(context.request.params);
    const { settings } = await context.operations.compliance.settings.get();
    const found = await context.operations.compliance.preferences.get(
      phoneNumber,
      settings.scrub.provider,
    );
    return found ?? operationsRequestError(404, 'preference_not_found', 'No scrub result');
  });

  on('get', '/v1/operations/compliance/complaints', 'editor', async ({ request, operations }) => ({
    items: await operations.compliance.complaints.list(schemas.complaintList.parse(request.query)),
  }));

  on('post', '/v1/operations/compliance/complaints', 'editor', async (context) => {
    const body = schemas.complaint.parse(context.request.body);
    const opened = await context.operations.compliance.openComplaint({
      ...body,
      receivedAt: new Date(body.receivedAt),
    });
    await audit(context.principal, 'operations.compliance.complaint.open', 'complaint', opened.id, {
      kind: opened.kind,
      ...(opened.phoneNumber ? { phone: digest(opened.phoneNumber) } : {}),
    });
    return context.reply.code(201).send(opened);
  });

  on('post', '/v1/operations/compliance/complaints/:id/transition', 'editor', async (context) => {
    const { id } = schemas.idParams.parse(context.request.params);
    const body = schemas.complaintTransition.parse(context.request.body);
    const result = await context.operations.compliance.complaints
      .transition(id, body.status, body.note)
      .catch(notFoundAs('complaint_not_found', 'Complaint not found'));
    if (result === 'invalid_transition')
      return operationsRequestError(409, 'complaint_transition_invalid', 'Not a next status');
    await audit(
      context.principal,
      `operations.compliance.complaint.${body.status}`,
      'complaint',
      id,
    );
    return result;
  });
}
