import { loadDistribution } from '@winsendotai/ovo-distribution';
import { PostgresOperationsService } from '@winsendotai/ovo-plugin-operations';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installInboundCarriers } from '../src/inbound-carrier-installation.ts';

describe('media gateway inbound carrier installation', () => {
  it.each([
    ['without credentials', {}, 'twilio'],
    [
      'with incompatible configured bindings',
      { OVO_CARRIER_ENV_BINDINGS: JSON.stringify({ other: { accountSid: 'AC-other' } }) },
      undefined,
    ],
  ] as const)(
    'selects a sole control only when the environment permits it %s',
    async (_label, env, carrierId) => {
      const operations = new PostgresOperationsService({
        connectionString: 'postgres://unused:unused@127.0.0.1/unused',
        organizationId: 'gateway-test',
      });
      try {
        const distribution = await loadDistribution({ role: 'gateway', profile: 'compose', env });
        const installed = vi.spyOn(operations.inboundGateway, 'setInstalledCarrierPlugins');
        installInboundCarriers(operations, distribution, env);
        expect(installed).toHaveBeenCalledWith(
          expect.arrayContaining([
            { pluginId: '@winsendotai/ovo-carrier-twilio', carrierId: 'twilio' },
          ]),
          carrierId,
        );
      } finally {
        await operations.close();
      }
    },
  );

  it('refuses unarmed admission with an explicit configuration error before SQL', async () => {
    const operations = new PostgresOperationsService({
      connectionString: 'postgres://unused:unused@127.0.0.1/unused',
      organizationId: 'gateway-unarmed',
    });
    try {
      expect(() => operations.inboundGateway.assertArmed()).toThrow(
        'Inbound carrier gate is not installed',
      );
      await expect(
        operations.inboundGateway.admit({
          carrierCallId: 'CA-unarmed',
          fromNumber: '+14155550902',
          toNumber: '+14155550901',
          routeTokenHash: 'a'.repeat(64),
          handshakeTtlMs: 60_000,
        }),
      ).rejects.toThrow('Inbound carrier gate is not installed');
    } finally {
      await operations.close();
    }
  });

  it('arms the service constructed by the gateway process from its loaded distribution', async () => {
    const operations = new PostgresOperationsService({
      connectionString: 'postgres://unused:unused@127.0.0.1/unused',
      organizationId: 'gateway-test',
    });
    try {
      const distribution = await loadDistribution({
        role: 'gateway',
        profile: 'compose',
        env: {},
      });
      const installed = vi.spyOn(operations.inboundGateway, 'setInstalledCarrierPlugins');
      installInboundCarriers(operations, distribution, {
        TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
        TWILIO_AUTH_TOKEN: 'test-token',
      });
      expect(() => operations.inboundGateway.assertArmed()).not.toThrow();
      expect(installed).toHaveBeenCalledWith(
        expect.arrayContaining([
          { pluginId: '@winsendotai/ovo-carrier-twilio', carrierId: 'twilio' },
        ]),
        'twilio',
      );
    } finally {
      await operations.close();
    }
  });
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('gateway admission with its process-installed carriers', () => {
  it.each([
    ['explicit installed', '@winsendotai/ovo-carrier-twilio'],
    ['NULL environment', null],
  ] as const)('admits a %s carrier route', async (_label, carrierPluginId) => {
    const organizationId = `gateway-carrier-${randomUUID()}`;
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
        TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
        TWILIO_AUTH_TOKEN: 'test-token',
      };
      const distribution = await loadDistribution({ role: 'gateway', profile: 'compose', env });
      installInboundCarriers(operations, distribution, env);
      await operations.inboundRoutes.put({
        phoneNumber: '+14155550901',
        releaseId: randomUUID(),
        expectedVersion: null,
        carrierPluginId,
        carrierBindingId: null,
      });
      await operations.inbound.registerProtectedCapacity({
        slotId: `gateway-${randomUUID()}`,
        workerId: 'worker-1',
        workerEndpoint: 'wss://worker.example.test/session',
        generation: 7,
        ready: true,
        protectedUntil: new Date(Date.now() + 180_000),
      });
      const admitted = await operations.inboundGateway.admit({
        carrierCallId: `CA${randomUUID().replaceAll('-', '')}`,
        fromNumber: '+14155550902',
        toNumber: '+14155550901',
        routeTokenHash: 'a'.repeat(64),
        handshakeTtlMs: 60_000,
      });
      expect(admitted.kind).toBe('reserved');
    } finally {
      await operations.pool.query('DELETE FROM ovo_session_routes WHERE organization_id = $1', [
        organizationId,
      ]);
      await operations.pool.query('DELETE FROM ovo_jobs WHERE workspace_id = $1', [organizationId]);
      await operations.pool.query('DELETE FROM ovo_ops_call_bindings WHERE organization_id = $1', [
        organizationId,
      ]);
      await operations.pool.query(
        'DELETE FROM ovo_ops_inbound_admissions WHERE organization_id = $1',
        [organizationId],
      );
      await operations.pool.query(
        'DELETE FROM ovo_ops_inbound_capacity WHERE organization_id = $1',
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
