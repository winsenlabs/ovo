import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '@winsendotai/ovo-runtime';
import { createOperationsRuntime, type OperationsRuntime } from '../src/operations-runtime.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const databaseTest = databaseUrl ? it : it.skip;

describe('operations runtime', () => {
  let runtime: OperationsRuntime | undefined;
  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  databaseTest(
    'constructs a bounded default-off process runtime and shuts down idempotently',
    async () => {
      const organizationId = randomUUID();
      runtime = await createOperationsRuntime({
        organizationId,
        databaseUrl,
        environment: {
          OVO_LIVE_DIAL_ENABLED: 'false',
          OVO_PERMITTED_FROM_NUMBERS: '+14155550101,+14155550101',
          OVO_OPERATIONS_PG_MAX_CONNECTIONS: '3',
        },
      });
      expect(runtime.config).toEqual({
        organizationId,
        maxConnections: 3,
        operations: { permittedFromNumbers: ['+14155550101'], liveEnabled: false },
        handoffProvider: 'unavailable',
      });
      expect(runtime.service.pool.options.max).toBe(3);
      expect(runtime.service.handoffs.available).toBe(false);
      const before = await runtime.service.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ovo_ops_handoffs WHERE organization_id = $1',
        [organizationId],
      );
      await expect(
        runtime.service.handoffs.request({
          operationId: randomUUID(),
          sessionId: randomUUID(),
          carrierCallId: 'CA-not-used',
          target: { kind: 'phone', value: '+14155550102' },
          fallback: { kind: 'end', message: 'Goodbye' },
          confirmationRequired: false,
        }),
      ).rejects.toMatchObject({ code: 'handoff_unavailable', statusCode: 503 });
      const after = await runtime.service.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ovo_ops_handoffs WHERE organization_id = $1',
        [organizationId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);

      const composition = await compose(
        [{ id: runtime.plugin.manifest.id, config: {} }],
        [runtime.plugin],
      );
      expect(composition.ctx.get('ovo.operations')).toBe(runtime.service);
      await composition.dispose();
      await runtime.close();

      runtime = await createOperationsRuntime({
        organizationId,
        databaseUrl,
        liveEnabled: true,
        maxConnections: 1,
        permittedFromNumbers: ['+14155550101'],
        handoffProvider: {
          request: async () => ({ kind: 'confirmed', receiptId: 'fixture' }),
          fallback: async () => ({ kind: 'confirmed', receiptId: 'fixture' }),
          reconcile: async () => ({ kind: 'pending' }),
        },
      });
      expect(runtime.config).toMatchObject({
        operations: { liveEnabled: true },
        handoffProvider: 'carrier',
      });
      expect(runtime.service.handoffs.available).toBe(true);
    },
  );
});
