import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '@winsendotai/ovo-runtime';
import {
  TwilioHandoffProvider,
  createOperationsRuntime,
  type OperationsRuntime,
  type TwilioHandoffClient,
} from '../src/operations-runtime.ts';

describe('Twilio operations handoff provider', () => {
  it('returns a redacted authoritative receipt only after an accepted update', async () => {
    const updates: unknown[] = [];
    const client: TwilioHandoffClient = {
      async updateCall(callSid, update) {
        updates.push({ callSid, update });
        return { sid: callSid, dateUpdated: new Date('2026-09-20T12:00:00Z') };
      },
    };
    const provider = new TwilioHandoffProvider(client, 'https://voice.example/resume');
    const transferred = await provider.request({
      requestId: 'request-1',
      carrierCallId: 'CA-secret-carrier-id',
      target: { kind: 'phone', value: '+14155550100' },
    });
    expect(transferred).toMatchObject({ kind: 'confirmed' });
    expect(JSON.stringify(transferred)).not.toContain('CA-secret-carrier-id');
    expect(updates).toEqual([
      {
        callSid: 'CA-secret-carrier-id',
        update: {
          twiml: '<Response><Dial><Number>+14155550100</Number></Dial></Response>',
        },
      },
    ]);
    expect(
      await provider.fallback({
        requestId: 'request-2',
        carrierCallId: 'CA-secret-carrier-id',
        fallback: { kind: 'resume', message: 'Please wait' },
      }),
    ).toMatchObject({ kind: 'confirmed' });
    expect(updates.at(-1)).toMatchObject({
      update: { url: 'https://voice.example/resume', method: 'POST' },
    });
  });

  it('fails unknown without retry and classifies deterministic rejection', async () => {
    const timeout = new TwilioHandoffProvider({
      async updateCall() {
        throw new Error('network timeout');
      },
    });
    expect(
      await timeout.request({
        requestId: 'request-1',
        carrierCallId: 'CA1',
        target: { kind: 'queue', value: 'support' },
      }),
    ).toEqual({ kind: 'unknown', reason: 'Twilio handoff outcome is unknown' });
    expect(await timeout.reconcile('request-1')).toEqual({ kind: 'pending' });

    const rejected = new TwilioHandoffProvider({
      async updateCall() {
        throw Object.assign(new Error('bad target'), { status: 400 });
      },
    });
    expect(
      await rejected.request({
        requestId: 'request-2',
        carrierCallId: 'CA2',
        target: { kind: 'queue', value: 'support' },
      }),
    ).toEqual({ kind: 'rejected', retryable: false, reason: 'Twilio rejected handoff (400)' });
  });
});

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
        twilio: {
          accountSid: 'AC-test',
          authToken: 'test-token',
          client: {
            async updateCall(callSid) {
              return { sid: callSid };
            },
          },
        },
      });
      expect(runtime.config).toMatchObject({
        operations: { liveEnabled: true },
        handoffProvider: 'twilio',
      });
      expect(runtime.service.handoffs.available).toBe(true);
    },
  );
});
