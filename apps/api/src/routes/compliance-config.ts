import { createHash } from 'node:crypto';
import {
  ComplianceSettingsConflict,
  ComplianceSettingsInvalid,
  IN_TCCCPR_2026_10,
  normalizePhoneNumber,
  operationsApiSchemas as schemas,
  operationsRequestError,
} from '@winsendotai/ovo-plugin-operations';
import { campaignPolicy } from '../outbound-compliance.ts';
import { complianceRoutes } from './compliance-route-support.ts';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The workspace's compliance configuration: settings, the caller-number registry, A2P declarations
 * and the effective-policy preview the console shows. Reads are open to viewers; every change is
 * an admin action and is audited.
 */
export function registerComplianceConfigRoutes(input: RealtimeRouteDependencies): void {
  const on = complianceRoutes(input);
  const { audit } = input;

  on('get', '/v1/operations/compliance/settings', 'viewer', async ({ operations }) => ({
    ...(await operations.compliance.settings.get()),
    rulePack: { id: IN_TCCCPR_2026_10.id, version: IN_TCCCPR_2026_10.version },
    providers: operations.compliance.preferences.providerIds(),
  }));

  on('put', '/v1/operations/compliance/settings', 'admin', async (context) => {
    const body = schemas.complianceSettings.parse(context.request.body);
    const store = context.operations.compliance.settings;
    try {
      const saved = await store.put(body.settings, body.expectedVersion);
      const { organizationId } = context.operations;
      const action = 'operations.compliance.settings.update';
      await audit(context.principal, action, 'compliance-settings', organizationId, {
        version: saved.version,
        enforcement: saved.settings.enforcement,
        testNumbers: saved.settings.testNumbers.map(digest),
      });
      return saved;
    } catch (error) {
      if (error instanceof ComplianceSettingsConflict)
        return context.reply.code(409).send({
          error: { code: 'compliance_settings_conflict', message: error.message },
          current: error.current,
        });
      if (!(error instanceof ComplianceSettingsInvalid)) throw error;
      const [first] = error.problems;
      return context.reply.code(422).send({
        error: { code: first!.code, message: error.message, details: error.problems },
      });
    }
  });

  on('get', '/v1/operations/compliance/cli-numbers', 'viewer', async ({ operations }) => ({
    items: await operations.compliance.cli.list(),
  }));

  // Caller numbers are the sender's own, not personal data: the audit names them.
  on('put', '/v1/operations/compliance/cli-numbers/:phoneNumber', 'admin', async (context) => {
    const { phoneNumber } = schemas.suppressionParams.parse(context.request.params);
    const body = schemas.cliNumber.parse(context.request.body);
    const saved = await context.operations.compliance.cli.upsert({ ...body, phoneNumber });
    const { series, categories, status } = saved;
    await audit(
      context.principal,
      'operations.compliance.cli.upsert',
      'cli-number',
      saved.phoneNumber,
      {
        series,
        categories,
        status,
      },
    );
    return saved;
  });

  on('delete', '/v1/operations/compliance/cli-numbers/:phoneNumber', 'admin', async (context) => {
    const number = normalizePhoneNumber(
      schemas.suppressionParams.parse(context.request.params).phoneNumber,
    );
    const removed = await context.operations.compliance.cli.remove(number);
    if (!removed) return operationsRequestError(404, 'cli_number_not_found', 'Not registered');
    await audit(context.principal, 'operations.compliance.cli.delete', 'cli-number', number);
    return context.reply.code(204).send();
  });

  on('get', '/v1/operations/compliance/a2p-declarations', 'viewer', async ({ operations }) => ({
    items: await operations.compliance.cli.declarations(),
  }));

  on('post', '/v1/operations/compliance/a2p-declarations', 'admin', async (context) => {
    const body = schemas.a2pDeclaration.parse(context.request.body);
    const saved = await context.operations.compliance.cli.declare(body).catch((error: Error) => {
      return operationsRequestError(422, 'invalid_a2p_range', error.message);
    });
    const { rangeStart, rangeEnd, effectiveFrom } = saved;
    const action = 'operations.compliance.a2p.declare';
    await audit(context.principal, action, 'a2p-declaration', saved.id, {
      rangeStart,
      rangeEnd,
      effectiveFrom,
    });
    return context.reply.code(201).send(saved);
  });

  on(
    'post',
    '/v1/operations/compliance/a2p-declarations/:id/withdraw',
    'admin',
    async (context) => {
      const { id } = schemas.idParams.parse(context.request.params);
      if (!(await context.operations.compliance.cli.withdraw(id)))
        return operationsRequestError(404, 'a2p_declaration_not_found', 'Declaration not found');
      await audit(context.principal, 'operations.compliance.a2p.withdraw', 'a2p-declaration', id);
      return context.reply.code(204).send();
    },
  );

  // The effective policy a campaign would get: the window layers, caps and any write-time problem.
  on('post', '/v1/operations/compliance/policy-preview', 'viewer', async (context) => {
    const body = schemas.policyPreview.parse(context.request.body);
    const release = await input.store.getRelease(context.principal.workspaceId, body.releaseId);
    if (!release) return operationsRequestError(404, 'release_not_found', 'Release not found');
    const resolved = campaignPolicy(release, body);
    if (!resolved.ok)
      return context.reply
        .code(resolved.status)
        .send({ error: { code: resolved.code, message: resolved.message } });
    const { policy } = resolved.value;
    const { compliance } = context.operations;
    return {
      policy,
      ...(await compliance.effective(policy, body.recipient)),
      problems: await compliance.problems(policy, [body.recipient]),
    };
  });
}
