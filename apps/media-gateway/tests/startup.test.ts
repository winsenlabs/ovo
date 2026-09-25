import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Cap, type CarrierControlFactory } from '@winsendotai/ovo-contracts';
import { DISTRIBUTION_DEFAULTS, type LoadedDistribution } from '@winsendotai/ovo-distribution';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  fixtureCarrierCapabilities,
  fixtureCarrierIngress,
} from '../../../packages/conformance/src/drivers/fixture-carrier.ts';
import { MediaGateway } from '../../../packages/plugin-media/src/gateway.ts';
import { startGateway } from '../src/startup.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

function startupDistribution(): LoadedDistribution {
  const capabilities = fixtureCarrierCapabilities();
  const fixture = definePlugin(
    {
      id: '@fixture/carrier-gateway-startup',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'process',
      kind: 'carrier',
      provider: 'fixture',
      provides: [Cap.carrierControl, Cap.carrierIngress],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      bindingSchema: { type: 'object', additionalProperties: true },
      secretFields: [],
      capabilities,
      meters: [
        {
          key: 'fixture.audio_seconds',
          unit: 'audio_seconds',
          label: 'Fixture',
          role: 'carrier',
        },
      ],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['carrier@1'],
    },
    (ctx) => {
      ctx.provide(Cap.carrierControl, {
        capabilities,
        create: () => {
          throw new Error('fixture carrier never dials');
        },
      } satisfies CarrierControlFactory);
      ctx.provide(Cap.carrierIngress, fixtureCarrierIngress());
    },
  );
  return {
    catalog: [fixture],
    processRows: [{ id: fixture.manifest.id }],
    defaults: DISTRIBUTION_DEFAULTS,
    fixtures: {},
    fixtureTemplates: {},
    unavailable: [],
  };
}

describe.skipIf(!postgresUrl)('gateway production startup', () => {
  it('refuses a public base URL with credentials before advertising readiness', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('probe has no port');
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      runtime = await startGateway({
        distribution: startupDistribution(),
        env: {
          DATABASE_URL: postgresUrl,
          OVO_MEDIA_PUBLIC_BASE_URL: 'https://user:secret@voice.example.test',
          OVO_MEDIA_WORKER_TOKEN: 'fixture-worker-token',
          OVO_INBOUND_ROUTE_SECRET: 'fixture-route-secret-32-bytes-long',
          OVO_ORGANIZATION_ID: 'fixture-org',
          OVO_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
          OVO_CARRIER_ENV_BINDINGS: JSON.stringify({ fixture: { authToken: 'fixture-secret' } }),
          OVO_MEDIA_HOST: '127.0.0.1',
          OVO_MEDIA_PORT: String(address.port),
        },
      });
      expect.fail('gateway advertised readiness for a public URL with credentials');
    } catch (error) {
      expect(error).toHaveProperty(
        'message',
        'Carrier public base URL must be https without credentials or query',
      );
    } finally {
      await runtime?.close();
    }
  });

  it('serves an authenticated carrier path only after host ports are ready', async () => {
    const distribution = startupDistribution();
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('probe has no port');
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const originalListen = MediaGateway.prototype.listen;
    const statuses: number[] = [];
    const drainTimeouts: number[] = [];
    const preAcceptDefaults: Array<{ duration?: number; legacyFrames?: number }> = [];
    const listen = vi.spyOn(MediaGateway.prototype, 'listen').mockImplementation(async function (
      this: MediaGateway,
    ) {
      const config = (
        this as unknown as {
          config: { drainTimeoutMs: number; preAcceptBufferMs?: number; maxPendingFrames?: number };
        }
      ).config;
      drainTimeouts.push(config.drainTimeoutMs);
      preAcceptDefaults.push({
        duration: config.preAcceptBufferMs,
        legacyFrames: config.maxPendingFrames,
      });
      const bound = await originalListen.call(this);
      const response = await fetch(`http://127.0.0.1:${bound.port}/carriers/fixture/env/status`, {
        method: 'POST',
        body: '',
      });
      statuses.push(response.status);
      return bound;
    });
    let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      runtime = await startGateway({
        distribution,
        env: {
          DATABASE_URL: postgresUrl,
          OVO_ORGANIZATION_ID: `gateway-startup-${randomUUID()}`,
          OVO_MEDIA_PUBLIC_BASE_URL: 'https://voice.example.test',
          OVO_MEDIA_WORKER_TOKEN: 'fixture-worker-token',
          OVO_INBOUND_ROUTE_SECRET: 'fixture-route-secret-32-bytes-long',
          OVO_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
          OVO_CARRIER_ENV_BINDINGS: JSON.stringify({ fixture: { authToken: 'fixture-secret' } }),
          OVO_MEDIA_HOST: '127.0.0.1',
          OVO_MEDIA_PORT: String(address.port),
        },
      });
      expect(statuses).toEqual([401]);
      expect(drainTimeouts).toEqual([270_000]);
      expect(preAcceptDefaults).toEqual([{ duration: undefined, legacyFrames: undefined }]);
      expect((await fetch(`http://127.0.0.1:${address.port}/health`)).status).toBe(200);
    } finally {
      listen.mockRestore();
      await runtime?.close();
    }
  });
});
