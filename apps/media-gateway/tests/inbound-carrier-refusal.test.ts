import { randomUUID } from 'node:crypto';
import { Cap } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { PostgresOperationsService } from '@winsendotai/ovo-plugin-operations';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { manifestKeys, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { installInboundCarriers } from '../src/inbound-carrier-installation.ts';
import { createGatewayHost } from '../src/gateway-host.ts';
import { fixtureCarrierIngress } from '../../../packages/conformance/src/drivers/fixture-carrier.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('durable inbound carrier configuration refusals', () => {
  it('records a missing env binding through the gateway host admission path', async () => {
    const organizationId = `gateway-host-refusal-${randomUUID()}`;
    const operations = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId,
      config: { liveEnabled: false, permittedFromNumbers: [] },
    });
    const orchestration = new PostgresOrchestrationStore({ connectionString: postgresUrl! });
    try {
      await orchestration.migrate();
      await operations.migrate();
      const distribution = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
      const environmentCarrierId = installInboundCarriers(operations, distribution, {});
      expect(environmentCarrierId).toBeUndefined();
      await operations.inboundRoutes.put({
        phoneNumber: '+14155550901',
        releaseId: randomUUID(),
        expectedVersion: null,
        carrierPluginId: null,
        carrierBindingId: null,
      });
      const ingress = { ...fixtureCarrierIngress(), carrierId: 'twilio' };
      const host = createGatewayHost({
        publicBaseUrl: 'https://voice.example.test',
        routeSecret: 'r'.repeat(32),
        store: orchestration,
        operations,
        distribution,
        control: {} as never,
        secrets: {} as never,
        ingresses: [ingress],
        environmentCarrierId,
        env: {},
      }).hostFor('twilio', 'env');
      const carrierCallId = `CA${randomUUID().replaceAll('-', '')}`;
      const decision = await host.admitInbound({
        carrierId: 'twilio',
        bindingId: 'env',
        carrierCallId,
        from: '+14155550902',
        to: '+14155550901',
        receivedAt: new Date(),
      });
      expect(decision).toMatchObject({ kind: 'busy' });
      const persisted = await operations.pool.query<{
        decision: string;
        detail: { reason: string };
      }>(
        `SELECT decision, detail FROM ovo_ops_inbound_admissions
         WHERE organization_id = $1 AND call_id = $2`,
        [organizationId, carrierCallId],
      );
      expect(persisted.rows).toEqual([
        {
          decision: 'busy',
          detail: { kind: 'busy', reason: 'inbound_carrier_configuration_env_unavailable' },
        },
      ]);
    } finally {
      await operations.pool.query(
        'DELETE FROM ovo_ops_inbound_admissions WHERE organization_id = $1',
        [organizationId],
      );
      await operations.pool.query('DELETE FROM ovo_ops_inbound_routes WHERE organization_id = $1', [
        organizationId,
      ]);
      await operations.close();
      await orchestration.close();
    }
  });

  it('records a waiting call as refused when its carrier disappears before resume', async () => {
    const organizationId = `gateway-wait-refusal-${randomUUID()}`;
    const operations = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId,
      config: { liveEnabled: true, permittedFromNumbers: ['+14155550901'] },
    });
    const orchestration = new PostgresOrchestrationStore({ connectionString: postgresUrl! });
    try {
      await orchestration.migrate();
      await operations.migrate();
      const env = {
        OVO_CARRIER_ENV_BINDINGS: JSON.stringify({ twilio: { authToken: 'fixture-secret' } }),
      };
      const distribution = await loadDistribution({ role: 'gateway', profile: 'compose', env });
      installInboundCarriers(operations, distribution, env);
      await operations.inboundRoutes.put({
        phoneNumber: '+14155550901',
        releaseId: randomUUID(),
        expectedVersion: null,
        carrierPluginId: null,
        carrierBindingId: null,
      });
      await operations.inbound.setPolicy(
        { kind: 'wait', maxWaitMs: 30_000, announcement: 'Please wait' },
        null,
      );
      const input = {
        carrierCallId: `CA${randomUUID().replaceAll('-', '')}`,
        fromNumber: '+14155550902',
        toNumber: '+14155550901',
        routeTokenHash: 'a'.repeat(64),
        handshakeTtlMs: 60_000,
      };
      expect((await operations.inboundGateway.admit(input)).kind).toBe('wait');
      operations.inboundGateway.setInstalledCarrierPlugins([]);
      const refused = await operations.inboundGateway.admit(input);
      expect(refused).toMatchObject({
        kind: 'busy',
        reason: 'inbound_carrier_configuration_env_unavailable',
      });
      const persisted = await operations.pool.query<{
        decision: string;
        detail: { reason: string };
      }>('SELECT decision, detail FROM ovo_ops_inbound_admissions WHERE id = $1', [
        refused.admissionId,
      ]);
      expect(persisted.rows[0]).toMatchObject({
        decision: 'busy',
        detail: { reason: 'inbound_carrier_configuration_env_unavailable' },
      });
    } finally {
      await operations.pool.query(
        'DELETE FROM ovo_ops_inbound_admissions WHERE organization_id = $1',
        [organizationId],
      );
      await operations.pool.query('DELETE FROM ovo_ops_inbound_policy WHERE organization_id = $1', [
        organizationId,
      ]);
      await operations.pool.query('DELETE FROM ovo_ops_inbound_routes WHERE organization_id = $1', [
        organizationId,
      ]);
      await operations.close();
      await orchestration.close();
    }
  });

  it.each([
    ['no installed control', 'none', null, 'inbound_carrier_configuration_env_unavailable'],
    ['ambiguous environment', 'ambiguous', null, 'inbound_carrier_configuration_env_unavailable'],
    ['configured mismatch', 'mismatch', null, 'inbound_carrier_configuration_env_unavailable'],
    [
      'uninstalled explicit plugin',
      'normal',
      '@fixture/uninstalled-carrier',
      'inbound_carrier_configuration_plugin_uninstalled',
    ],
  ] as const)('records %s without a job or session', async (_label, variant, pluginId, reason) => {
    const organizationId = `gateway-refusal-${randomUUID()}`;
    const operations = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId,
      config: { liveEnabled: true, permittedFromNumbers: ['+14155550901'] },
    });
    const orchestration = new PostgresOrchestrationStore({ connectionString: postgresUrl! });
    try {
      await orchestration.migrate();
      await operations.migrate();
      const env =
        variant === 'mismatch' ? { OVO_CARRIER_ENV_BINDINGS: JSON.stringify({ other: {} }) } : {};
      const distribution = await loadDistribution({ role: 'gateway', profile: 'compose', env });
      const controls = distribution.catalog.filter((definition) =>
        manifestKeys(definition.manifest).provides.some(
          (service) => service.key === Cap.carrierControl,
        ),
      );
      const catalog =
        variant === 'none'
          ? distribution.catalog.filter((definition) => !controls.includes(definition))
          : variant === 'ambiguous'
            ? [
                ...distribution.catalog,
                {
                  ...controls[0]!,
                  manifest: {
                    ...controls[0]!.manifest,
                    id: '@fixture/second-carrier',
                    capabilities: {
                      ...manifestKeys(controls[0]!.manifest).manifest.capabilities,
                      carrierId: 'other',
                    },
                  },
                } as PluginDefinition,
              ]
            : distribution.catalog;
      installInboundCarriers(operations, { catalog }, env);
      operations.inboundGateway.assertArmed();
      await operations.inboundRoutes.put({
        phoneNumber: '+14155550901',
        releaseId: randomUUID(),
        expectedVersion: null,
        carrierPluginId: pluginId,
        carrierBindingId: null,
      });
      const carrierCallId = `CA${randomUUID().replaceAll('-', '')}`;
      const decision = await operations.inboundGateway.admit({
        carrierCallId,
        fromNumber: '+14155550902',
        toNumber: '+14155550901',
        routeTokenHash: 'a'.repeat(64),
        handshakeTtlMs: 60_000,
      });
      expect(decision).toMatchObject({ kind: 'busy', reason });
      const admission = await operations.pool.query<{
        decision: string;
        detail: { reason: string };
      }>(
        `SELECT decision, detail FROM ovo_ops_inbound_admissions
         WHERE organization_id = $1 AND call_id = $2`,
        [organizationId, carrierCallId],
      );
      expect(admission.rows).toEqual([{ decision: 'busy', detail: { kind: 'busy', reason } }]);
      const jobs = await operations.pool.query<{ count: string }>(
        'SELECT count(*) FROM ovo_jobs WHERE workspace_id = $1',
        [organizationId],
      );
      expect(jobs.rows[0]?.count).toBe('0');
    } finally {
      await operations.pool.query(
        'DELETE FROM ovo_ops_inbound_admissions WHERE organization_id = $1',
        [organizationId],
      );
      await operations.pool.query('DELETE FROM ovo_ops_inbound_routes WHERE organization_id = $1', [
        organizationId,
      ]);
      await operations.close();
      await orchestration.close();
    }
  });
});
