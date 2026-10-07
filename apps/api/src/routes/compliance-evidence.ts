import { createHash } from 'node:crypto';
import { operationsApiSchemas as schemas } from '@winsendotai/ovo-plugin-operations';
import { complianceRoutes } from './compliance-route-support.ts';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

/**
 * The audit trail (spec 3.8): the decision log, the abandoned/silent ratios per caller number, the
 * regulator export ZIP and the complaint-response evidence packet. Exports are admin only and are
 * themselves audited.
 */
export function registerComplianceEvidenceRoutes(input: RealtimeRouteDependencies): void {
  const on = complianceRoutes(input);

  on('get', '/v1/operations/compliance/decisions', 'editor', async ({ request, operations }) => ({
    items: await operations.compliance.decisions(schemas.decisionQuery.parse(request.query)),
  }));

  on('get', '/v1/operations/compliance/ratios', 'viewer', async ({ operations }) => ({
    items: await operations.compliance.ratios(),
  }));

  on('get', '/v1/operations/compliance/export', 'admin', async (context) => {
    const query = schemas.exportQuery.parse(context.request.query);
    const { zip, manifest } = await context.operations.compliance.export({
      from: new Date(query.from),
      to: new Date(query.to),
      ...(query.phoneNumber ? { phoneNumber: query.phoneNumber } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
    });
    const sha256 = createHash('sha256').update(zip).digest('hex');
    await input.audit(
      context.principal,
      'operations.compliance.export',
      'compliance-export',
      sha256,
      {
        from: query.from,
        to: query.to,
        files: manifest.files,
      },
    );
    return context.reply
      .header('content-type', 'application/zip')
      .header(
        'content-disposition',
        `attachment; filename="ovo-compliance-${query.from.slice(0, 10)}.zip"`,
      )
      .send(zip);
  });

  on('get', '/v1/operations/compliance/evidence', 'admin', async (context) => {
    const query = schemas.evidenceQuery.parse(context.request.query);
    const packet = await context.operations.compliance.evidence(
      query.phoneNumber,
      new Date(query.date),
    );
    const subject = createHash('sha256').update(query.phoneNumber).digest('hex');
    await input.audit(
      context.principal,
      'operations.compliance.evidence',
      'compliance-evidence',
      subject,
      {
        date: query.date,
      },
    );
    return packet;
  });
}
