import { describe, expect, it, vi } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { compose, configError, definePlugin } from '@winsendotai/ovo-runtime';
import { recordingsPlugin } from '@winsendotai/ovo-plugin-recordings';
import { secretsPlugin } from '@winsendotai/ovo-plugin-secrets';
import { FIRST_PARTY } from '../src/catalog.ts';
import { legacyEnvBindings } from '../src/env-bindings.ts';
import { deepgramSttBridge } from '../src/legacy/deepgram-stt.ts';
import { openAiLlmBridge } from '../src/legacy/openai-llm.ts';
import { openAiTtsBridge } from '../src/legacy/openai-tts.ts';
import { twilioCarrierBridge } from '../src/legacy/twilio-carrier.ts';
import { loadDistribution } from '../src/load.ts';

describe('distribution inventory', () => {
  const workerEnv = {
    DATABASE_URL: 'postgres://local',
    OVO_QUEUE_URL: 'http://localhost/queue',
    AWS_REGION: 'us-east-1',
    OVO_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  it('pre-registers every F3 skeleton and frozen dispatcher subpath', () => {
    const names = new Set(FIRST_PARTY.map((entry) => entry.package));
    for (const name of [
      'plugin-turns',
      'plugin-vad',
      'plugin-engine-livekit',
      'plugin-carrier-twilio',
      'plugin-carrier-exotel',
      'plugin-carrier-plivo',
      'plugin-stt-deepgram',
      'plugin-tts-openai',
      'plugin-llm-openai',
      'plugin-stt-assemblyai',
      'plugin-speech-sarvam',
      'fixture-calls',
    ])
      expect(names.has(`@winsendotai/ovo-${name}`)).toBe(true);
    for (const name of [
      'plugin-operations/background-tasks',
      'plugin-ledger/background-tasks',
      'plugin-orchestration/background-tasks',
      'plugin-orchestration/capacity-signals',
    ])
      expect(names.has(`@winsendotai/ovo-${name}`)).toBe(true);
  });

  it('loads skeletons, the old engine and all four valid bridge definitions', async () => {
    const loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
    for (const bridge of [
      deepgramSttBridge,
      openAiTtsBridge,
      openAiLlmBridge,
      twilioCarrierBridge,
    ]) {
      const installed = loaded.catalog.find((item) => item.manifest.id === bridge.manifest.id);
      expect(installed?.manifest.contractVersion).toBe(2);
    }
    expect(loaded.catalog.map((item) => item.manifest.id)).toContain(
      '@winsendotai/ovo-plugin-voice-session-engine',
    );
    expect(loaded.processRows.map((row) => row.id)).toContain(twilioCarrierBridge.manifest.id);
  });

  it.each(['api', 'worker', 'gateway', 'dispatcher'] as const)(
    'loads the %s profile with exactly one row per process plugin',
    async (role) => {
      const loaded = await loadDistribution({
        role,
        profile: 'compose',
        env: role === 'worker' || role === 'dispatcher' ? workerEnv : {},
      });
      const processIds = loaded.catalog
        .filter((definition) => definition.manifest.scope === 'process')
        .map((definition) => definition.manifest.id)
        .sort();
      expect(loaded.processRows.map((row) => row.id).sort()).toEqual(processIds);
    },
  );

  it.each(['api', 'worker', 'dispatcher', 'gateway'] as const)(
    'builds valid process configs for %s',
    async (role) => {
      const loaded = await loadDistribution({
        role,
        profile: 'compose',
        env: role === 'worker' || role === 'dispatcher' ? workerEnv : {},
      });
      for (const row of loaded.processRows) {
        const definition = loaded.catalog.find((plugin) => plugin.manifest.id === row.id)!;
        expect(configError(definition.manifest, row.config ?? {}), row.id).toBeUndefined();
      }
    },
  );

  it('omits the fixture recording archive in production without S3 and configures S3 when present', async () => {
    const none = await loadDistribution({
      role: 'api',
      profile: 'compose',
      env: { NODE_ENV: 'production' },
    });
    expect(none.catalog.some((plugin) => plugin.manifest.id === recordingsPlugin.manifest.id)).toBe(
      false,
    );
    const bucket = await loadDistribution({
      role: 'api',
      profile: 'fargate',
      env: {
        NODE_ENV: 'production',
        OVO_RECORDINGS_BUCKET: 'fixture-bucket',
        AWS_REGION: 'us-east-1',
      },
    });
    expect(
      bucket.processRows.find((row) => row.id === recordingsPlugin.manifest.id)?.config,
    ).toMatchObject({ backend: 's3', bucket: 'fixture-bucket' });
  });

  it('composes configured API recordings and worker secrets against local host services', async () => {
    const api = await loadDistribution({ role: 'api', profile: 'compose', env: {} });
    const recording = api.processRows.find((row) => row.id === recordingsPlugin.manifest.id)!;
    const recorded = await compose([recording], [recordingsPlugin], { scope: 'process' });
    await recorded.dispose();

    const worker = await loadDistribution({ role: 'worker', profile: 'compose', env: workerEnv });
    const secrets = worker.processRows.find((row) => row.id === secretsPlugin.manifest.id)!;
    const store = definePlugin(
      {
        id: 'fixture-control-store',
        version: '0.1.0',
        contractVersion: 1,
        scope: 'process',
        requires: [],
        provides: [Cap.controlStore],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => void ctx.provide(Cap.controlStore, {}),
    );
    const composed = await compose([{ id: store.manifest.id }, secrets], [store, secretsPlugin], {
      scope: 'process',
    });
    await composed.dispose();
  });

  it('fails early when worker infrastructure variables are missing', async () => {
    await expect(loadDistribution({ role: 'worker', profile: 'compose', env: {} })).rejects.toThrow(
      'Missing required environment variable DATABASE_URL',
    );
  });

  it('uses the catalog package over an identically identified bridge', async () => {
    const log = vi.fn();
    const replacement = {
      ...twilioCarrierBridge,
      manifest: { ...twilioCarrierBridge.manifest, version: '0.2.0' },
    };
    const loaded = await loadDistribution({
      role: 'gateway',
      profile: 'compose',
      env: {},
      firstParty: [
        {
          package: '@winsendotai/ovo-plugin-carrier-twilio',
          roles: ['gateway'],
          load: async () => ({ plugins: [replacement] }),
        },
      ],
      legacyBridges: [twilioCarrierBridge],
      log,
    });
    expect(
      loaded.catalog.filter((item) => item.manifest.id === twilioCarrierBridge.manifest.id),
    ).toHaveLength(1);
    expect(loaded.catalog[0]?.manifest.version).toBe('0.2.0');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('supersedes legacy bridge'));
  });

  it('rejects duplicate catalog packages and malformed exports', async () => {
    const entry = {
      package: '@winsendotai/ovo-plugin-vad',
      roles: ['gateway'] as const,
      load: async () => ({ plugins: [] }),
    };
    await expect(
      loadDistribution({
        role: 'gateway',
        profile: 'compose',
        env: {},
        firstParty: [entry, entry],
        legacyBridges: [],
      }),
    ).rejects.toThrow('Duplicate catalog package');
    await expect(
      loadDistribution({
        role: 'gateway',
        profile: 'compose',
        env: {},
        firstParty: [{ ...entry, load: async () => ({ plugins: 'broken' }) }],
        legacyBridges: [],
      }),
    ).rejects.toThrow('Invalid plugin catalog package');
  });

  it('rejects an OVO_PLUGIN_MODULES entry duplicating a built-in package', async () => {
    await expect(
      loadDistribution({
        role: 'gateway',
        profile: 'compose',
        env: { OVO_PLUGIN_MODULES: '["@winsendotai/ovo-plugin-vad"]' },
        firstParty: [
          {
            package: '@winsendotai/ovo-plugin-vad',
            roles: ['gateway'],
            load: async () => ({ plugins: [] }),
          },
        ],
        legacyBridges: [],
      }),
    ).rejects.toThrow('duplicates catalog package');
  });
});

describe('environment carrier bindings', () => {
  it('translates a configured legacy Twilio pair', () => {
    expect(
      JSON.parse(
        legacyEnvBindings({
          TWILIO_ACCOUNT_SID: 'AC123',
          TWILIO_AUTH_TOKEN: 'secret',
        }).OVO_CARRIER_ENV_BINDINGS!,
      ),
    ).toEqual({ twilio: { accountSid: 'AC123', authToken: 'secret' } });
  });

  it.each([
    ['not-configured', 'secret'],
    ['AC123', 'disabled-local-account'],
    ['  ', 'secret'],
    ['AC123', ''],
  ])('rejects placeholder or incomplete values: %s / %s', (sid, token) => {
    expect(
      legacyEnvBindings({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token }),
    ).not.toHaveProperty('OVO_CARRIER_ENV_BINDINGS');
  });

  it('preserves explicit env bindings verbatim even when legacy values exist', () => {
    const explicit = '{"exotel":{"foo":1}}';
    expect(
      legacyEnvBindings({
        OVO_CARRIER_ENV_BINDINGS: explicit,
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'secret',
      }).OVO_CARRIER_ENV_BINDINGS,
    ).toBe(explicit);
  });
});
