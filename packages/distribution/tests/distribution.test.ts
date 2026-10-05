import { describe, expect, it } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { compose, configError, definePlugin } from '@winsendotai/ovo-runtime';
import { recordingsPlugin } from '@winsendotai/ovo-plugin-recordings';
import { LocalAesGcmSecretManager, secretsPlugin } from '@winsendotai/ovo-plugin-secrets';
import { NodeSqliteControlStore } from '@winsendotai/ovo-plugin-storage';
import { FIRST_PARTY } from '../src/catalog.ts';
import { envCarrierBindings, legacyEnvBindings } from '../src/env-bindings.ts';
import { loadDistribution } from '../src/load.ts';

describe('distribution inventory', () => {
  it('loads plugin arrays from their owning packages so future plugins need no catalog edit', async () => {
    for (const name of [
      '@winsendotai/ovo-plugin-voice',
      '@winsendotai/ovo-plugin-orchestration',
      '@winsendotai/ovo-plugin-storage',
      '@winsendotai/ovo-plugin-secrets',
      '@winsendotai/ovo-plugin-observability',
      '@winsendotai/ovo-plugin-recordings',
    ]) {
      const entry = FIRST_PARTY.find((item) => item.package === name);
      expect(entry).toBeDefined();
      const owner = (await import(name)) as { plugins?: unknown };
      expect(Array.isArray(owner.plugins)).toBe(true);
      expect(((await entry!.load()) as { plugins?: unknown }).plugins).toBe(owner.plugins);
    }
  });
  it('picks up an additional voice plugin without editing the frozen catalog', async () => {
    const voice = await import('@winsendotai/ovo-plugin-voice');
    const original = voice.plugins[0]!;
    const added = {
      ...original,
      manifest: { ...original.manifest, id: 'fixture.voice-added-after-f3' },
    };
    voice.plugins.push(added);
    try {
      const loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
      expect(loaded.catalog.map((item) => item.manifest.id)).toContain(added.manifest.id);
    } finally {
      voice.plugins.pop();
    }
  });
  const workerEnv = {
    DATABASE_URL: 'postgres://local',
    OVO_QUEUE_URL: 'http://localhost/queue',
    AWS_REGION: 'us-east-1',
    OVO_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  const dispatcherEnv = {
    ...workerEnv,
    OVO_DLQ_URL: 'http://127.0.0.1:9324/000000000000/ovo-jobs-dlq',
  };
  const dispatcherHost = {
    package: 'fixture-dispatcher-host',
    roles: ['dispatcher'] as const,
    load: async () => ({
      plugins: [
        'ovo.operations.postgres',
        '@winsendotai/ovo-plugin-ledger',
        'ovo.dispatcher.node-net',
      ].map((id) =>
        definePlugin(
          {
            id,
            version: '0.1.0',
            contractVersion: 1,
            scope: 'process',
            requires: [],
            provides: [],
            configSchema: { type: 'object' },
            secretFields: [],
          },
          () => {},
        ),
      ),
    }),
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

  it('loads the installed engine and carrier plugins without transition bridges', async () => {
    const loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
    expect(
      loaded.catalog.some((item) => item.manifest.id === '@winsendotai/ovo-carrier-twilio'),
    ).toBe(true);
    expect(loaded.catalog.map((item) => item.manifest.id)).toContain(
      '@winsendotai/ovo-plugin-voice-session-engine',
    );
    expect(loaded.processRows.map((row) => row.id)).toContain('@winsendotai/ovo-carrier-twilio');
  });

  it.each(['api', 'worker', 'gateway', 'dispatcher'] as const)(
    'loads the %s profile with exactly one row per process plugin',
    async (role) => {
      const loaded = await loadDistribution({
        role,
        profile: 'compose',
        env: role === 'dispatcher' ? dispatcherEnv : role === 'worker' ? workerEnv : {},
        firstParty: role === 'dispatcher' ? [...FIRST_PARTY, dispatcherHost] : undefined,
      });
      const processIds = loaded.catalog
        .filter((definition) => definition.manifest.scope === 'process')
        .map((definition) => definition.manifest.id)
        .sort();
      expect(loaded.processRows.map((row) => row.id).sort()).toEqual(processIds);
    },
  );

  it.each(['api', 'worker', 'dispatcher', 'gateway'] as const)(
    'builds valid selected process configs for %s',
    async (role) => {
      const loaded = await loadDistribution({
        role,
        profile: 'compose',
        env: role === 'dispatcher' ? dispatcherEnv : role === 'worker' ? workerEnv : {},
        firstParty: role === 'dispatcher' ? [...FIRST_PARTY, dispatcherHost] : undefined,
      });
      // The dispatcher selects the log signal for Compose before composition.
      const selectedRows =
        role === 'dispatcher'
          ? loaded.processRows.filter(
              (row) =>
                row.id !== '@winsendotai/ovo-plugin-orchestration/cloudwatch-capacity-signal',
            )
          : loaded.processRows;
      if (role === 'dispatcher')
        expect(selectedRows.map((row) => row.id)).toContain(
          '@winsendotai/ovo-plugin-orchestration/log-capacity-signal',
        );
      for (const row of selectedRows) {
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

  it('passes the previous master key so credentials survive a master key rotation', async () => {
    const previous = Buffer.alloc(32, 6),
      control = new NodeSqliteControlStore(':memory:');
    try {
      await control.ensureWorkspace('workspace');
      const credential = await new LocalAesGcmSecretManager(control, previous).create({
        workspaceId: 'workspace',
        label: 'Before rotation',
        provider: 'fixture',
        type: 'api-key',
        environment: 'test',
        value: 'stored-before-rotation',
        createdBy: 'test',
      });
      const worker = await loadDistribution({
        role: 'worker',
        profile: 'compose',
        env: { ...workerEnv, OVO_SECRETS_MASTER_KEY_PREVIOUS: previous.toString('hex') },
      });
      const secrets = worker.processRows.find((row) => row.id === secretsPlugin.manifest.id)!;
      expect(secrets.config).toMatchObject({ previousMasterKeys: previous.toString('hex') });
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
        (ctx) => void ctx.provide(Cap.controlStore, control),
      );
      const composed = await compose(
        [
          { id: store.manifest.id },
          { ...secrets, config: { ...secrets.config, backend: 'local' } },
        ],
        [store, secretsPlugin],
        { scope: 'process' },
      );
      try {
        const manager = composed.get(Cap.secretManager) as LocalAesGcmSecretManager;
        await expect(manager.resolve('workspace', credential.id)).resolves.toBe(
          'stored-before-rotation',
        );
      } finally {
        await composed.dispose();
      }
    } finally {
      await control.close();
    }
  });

  it('fails early when worker infrastructure variables are missing', async () => {
    await expect(loadDistribution({ role: 'worker', profile: 'compose', env: {} })).rejects.toThrow(
      'Missing required environment variable DATABASE_URL',
    );
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
      }),
    ).rejects.toThrow('Duplicate catalog package');
    await expect(
      loadDistribution({
        role: 'gateway',
        profile: 'compose',
        env: {},
        firstParty: [{ ...entry, load: async () => ({ plugins: 'broken' }) }],
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
    ['disabled-local-account', 'disabled-local-token'],
    ['AC123', 'replace-with-token'],
  ])('rejects placeholder or incomplete values: %s / %s', (sid, token) => {
    expect(
      legacyEnvBindings({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token }),
    ).not.toHaveProperty('OVO_CARRIER_ENV_BINDINGS');
  });

  it.each([
    // What Compose rendered from bootstrap's placeholders before it stopped interpolating TWILIO_*.
    ['{"twilio":{"accountSid":"disabled-local-account","authToken":"disabled-local-token"}}'],
    ['{"twilio":{"accountSid":"","authToken":""}}'],
    ['{"twilio":{"accountSid":"replace-with-sid","authToken":"replace-with-token"}}'],
    [''],
  ])('reduces placeholder explicit bindings to none: %s', (explicit) => {
    const bindings = envCarrierBindings({ OVO_CARRIER_ENV_BINDINGS: explicit });
    expect(JSON.parse(bindings.env.OVO_CARRIER_ENV_BINDINGS!)).toEqual({});
    expect(bindings.active).toEqual([]);
  });

  it('keeps real explicit entries while dropping placeholder ones', () => {
    const bindings = envCarrierBindings({
      OVO_CARRIER_ENV_BINDINGS: JSON.stringify({
        twilio: { accountSid: 'AC123', authToken: 'disabled-local-token' },
        plivo: { accountSid: 'MA123', authToken: 'secret' },
      }),
    });
    expect(JSON.parse(bindings.env.OVO_CARRIER_ENV_BINDINGS!)).toEqual({
      plivo: { accountSid: 'MA123', authToken: 'secret' },
    });
    expect(bindings).toMatchObject({ active: ['plivo'], ignored: ['twilio'] });
    expect(
      envCarrierBindings({ OVO_CARRIER_ENV_BINDINGS: 'not json' }).env.OVO_CARRIER_ENV_BINDINGS,
    ).toBe('not json');
  });

  it('logs the active and ignored env carriers by name at startup, never their values', async () => {
    const entries: Record<string, unknown>[] = [];
    await loadDistribution({
      role: 'gateway',
      profile: 'compose',
      env: {
        OVO_CARRIER_ENV_BINDINGS: JSON.stringify({
          twilio: { accountSid: 'disabled-local-account', authToken: 'disabled-local-token' },
        }),
      },
      log: (entry) => entries.push(entry),
    });
    expect(entries).toEqual([
      {
        event: 'carrier_env_bindings',
        role: 'gateway',
        active: [],
        ignoredPlaceholders: ['twilio'],
      },
    ]);
    await loadDistribution({
      role: 'gateway',
      profile: 'compose',
      env: { OVO_CARRIER_ENV_BINDINGS: '{"fixture":{"authToken":"live-secret"}}' },
      log: (entry) => entries.push(entry),
    });
    expect(entries[1]).toMatchObject({ active: ['fixture'], ignoredPlaceholders: [] });
    expect(JSON.stringify(entries)).not.toContain('live-secret');
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
