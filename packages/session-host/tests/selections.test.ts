import { describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  Cap,
  type CarrierControlFactory,
  type ReleaseSelections,
} from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { normalizeAgentConfig } from '../src/normalize.ts';
import { selectEngine } from '../src/engine-selection.ts';
import { metersFor } from '../src/meters.ts';
import { CarrierRegistry } from '../src/carrier-registry.ts';
import { createCarrierBindingResolver } from '../src/carrier-bindings.ts';

const media = {
  formats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
  playbackEvidence: 'carrier-played',
  clear: true,
  clearFlushesMarkers: true,
  dtmf: true,
  queryOnMediaUrl: false,
};
const carrierCapabilities = {
  carrierId: 'fixture',
  media,
  control: {
    callIdTiming: 'at-dial',
    streamParams: 'at-dial',
    streamCallIdMatchesDial: true,
    cancelBeforeAnswer: true,
    handoff: [],
    amd: 'none',
    maxDuration: true,
    reconcile: 'by-call-id',
    hangup: 'rest',
  },
  continuation: 'none',
  webhookAuth: 'hmac-signature',
  pacing: { cps: 1 },
};
const carrier = definePlugin(
  {
    id: 'carrier',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'process',
    kind: 'carrier',
    provider: 'fixture',
    provides: [Cap.carrierControl],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
    capabilities: carrierCapabilities,
    meters: [{ key: 'carrier.call', unit: 'call_seconds', label: 'Call', role: 'carrier' }],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['carrier@1'],
  } as never,
  () => undefined,
);
const llm = (id: string) =>
  definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'llm',
      provider: 'openai',
      provides: [Cap.inference],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: { tools: true, streaming: true },
      meters: [{ key: 'llm.tokens', unit: 'input_tokens', label: 'Tokens', role: 'llm' }],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['llm@1'],
    } as never,
    () => undefined,
  );
const tts = definePlugin(
  {
    id: 'tts',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'tts',
    provider: 'fixture',
    provides: [Cap.tts],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
    capabilities: {
      languages: ['*'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
      outputFormats: [],
    },
    meters: [
      {
        key: 'tts.neural',
        unit: 'characters',
        label: 'Neural',
        role: 'tts',
        when: { field: 'model', in: ['neural'] },
      },
      {
        key: 'tts.basic',
        unit: 'characters',
        label: 'Basic',
        role: 'tts',
        when: { field: 'model', in: ['basic'] },
      },
    ],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['tts@1'],
  } as never,
  () => undefined,
);
const engineV2 = definePlugin(
  {
    id: 'engine-v2',
    version: '1.2.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'engine',
    provider: 'fixture',
    provides: [`${Cap.engine}@2`],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
    capabilities: {
      turnDetection: ['provider'],
      bargeIn: true,
      dtmf: true,
      confirmedPlayback: true,
      ownsProviders: false,
      formats: [],
      consumesTurnDetector: false,
    },
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['engine@1'],
  } as never,
  () => undefined,
);
const oldEngine = (id = 'old-engine', version = '1.0.0') =>
  definePlugin(
    {
      id,
      version,
      contractVersion: 1,
      scope: 'session',
      provides: [Cap.engine],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    () => undefined,
  );
const config = () =>
  AgentConfig.parse({ name: 'fixture', mode: 'context', providers: { inference: 'binding' } });

describe('selection helpers', () => {
  it('normalizes legacy inference and rejects ambiguous providers', () => {
    const binding = { id: 'binding', provider: 'openai' };
    const registry = new PluginRegistry([llm('llm-a'), engineV2]);
    const normalized = normalizeAgentConfig(
      config(),
      registry,
      { binding },
      { engine: 'engine-v2', turnDetector: 'missing' },
    );
    expect(normalized.config.voice?.llm).toMatchObject({ plugin: 'llm-a', binding: 'binding' });
    expect(normalized.warnings).toEqual([expect.stringContaining('Optional turn detector')]);
    const ambiguous = new PluginRegistry([llm('llm-a'), llm('llm-b'), engineV2]);
    expect(() =>
      normalizeAgentConfig(config(), ambiguous, { binding }, { engine: 'engine-v2' }),
    ).toThrow('Multiple installed llm');
    expect(() => normalizeAgentConfig(config(), registry, {}, { engine: 'engine-v2' })).toThrow(
      'binding is missing',
    );
  });
  it('filters conditional meters by binding config and announcement input mode', () => {
    const selections: ReleaseSelections = {
      tts: {
        pluginId: 'tts',
        version: '1.0.0',
        bindingId: 'b',
        binding: {
          provider: 'fixture',
          config: { model: 'neural' },
          credentialId: 'c',
          fingerprint: 'f',
          updatedAt: 't',
        },
        config: {},
      },
      carrier: { pluginId: 'carrier', version: '1.0.0', config: {} },
    };
    const registry = new PluginRegistry([tts, carrier]);
    expect(
      metersFor(selections, registry, { requiresInput: false }).map((row) => row.meter.key),
    ).toEqual(['carrier.call', 'tts.neural']);
    selections.tts!.binding!.config.model = 'basic';
    expect(
      metersFor(selections, registry, { requiresInput: true }).map((row) => row.meter.key),
    ).toEqual(['carrier.call', 'tts.basic']);
  });
  it('keeps exact v1 replacement pins/messages and accepts same-major v2 pins', () => {
    const old = oldEngine();
    const release = {
      config: AgentConfig.parse({ name: 'fixture', mode: 'announcement' }),
      plugins: [{ id: 'old-engine', version: '1.0.0' }],
    };
    const registry = new PluginRegistry([old, engineV2]);
    const selected = selectEngine(release, registry, { plugins: [old] }, () => engineV2);
    expect(selected).toMatchObject({
      definition: old,
      rowConfig: { language: 'en-IN', inputEnabled: false, initialInput: '' },
    });
    expect(() =>
      selectEngine(
        { ...release, plugins: [{ id: 'old-engine', version: '2.0.0' }] },
        registry,
        { plugins: [old] },
        () => engineV2,
      ),
    ).toThrow('does not satisfy release pin');
    expect(() =>
      selectEngine(
        { ...release, plugins: [{ id: 'missing', version: '1.0.0' }] },
        registry,
        { plugins: [] },
        () => engineV2,
      ),
    ).toThrow('live release plugin is not installed');
    expect(() =>
      selectEngine(
        {
          ...release,
          plugins: [
            { id: 'old-engine', version: '1.0.0' },
            { id: 'second', version: '1.0.0' },
          ],
        },
        new PluginRegistry([old, oldEngine('second')]),
        { plugins: [old, oldEngine('second')] },
        () => engineV2,
      ),
    ).toThrow('multiple installed voice session engine providers');
    const v2 = selectEngine(
      {
        ...release,
        selections: {
          engine: { pluginId: 'engine-v2', version: '1.0.0', config: { greeting: 'hi' } },
        },
      },
      registry,
      { plugins: [] },
      () => old,
    );
    expect(v2).toMatchObject({ exact: false, rowConfig: { greeting: 'hi' } });
  });
  it('resolves env and stored carrier bindings on use, rejecting placeholders and mismatches', async () => {
    const registry = new PluginRegistry([carrier]);
    const store = {
      getProviderBinding: vi.fn(async () => ({
        id: 'stored',
        workspaceId: 'w',
        provider: 'fixture',
        pluginId: 'carrier',
        credentialId: 'cred',
        config: { region: 'IN' },
      })),
    };
    const secrets = { resolve: vi.fn(async () => 'stored-secret') };
    const resolve = createCarrierBindingResolver({
      workspaceId: 'w',
      store,
      secrets: secrets as never,
      registry,
      env: {
        OVO_CARRIER_ENV_BINDINGS: JSON.stringify({
          fixture: { accountSid: 'account', authToken: 'env-secret' },
        }),
      },
    });
    expect(await resolve('env', 'fixture')).toMatchObject({
      pluginId: 'carrier',
      bindingId: 'env',
      secret: 'env-secret',
      config: { accountSid: 'account' },
    });
    expect(await resolve('stored', 'fixture')).toMatchObject({
      pluginId: 'carrier',
      secret: 'stored-secret',
    });
    expect(secrets.resolve).toHaveBeenCalledWith('w', 'cred');
    const missing = createCarrierBindingResolver({
      workspaceId: 'w',
      store,
      secrets: secrets as never,
      registry,
      env: {
        OVO_CARRIER_ENV_BINDINGS: JSON.stringify({
          fixture: { authToken: 'disabled-local-account' },
        }),
      },
    });
    await expect(missing('env', 'fixture')).rejects.toThrow('not configured');
    await expect(resolve('stored', 'other')).rejects.toThrow('does not match');
    const control = {
      capabilities: carrierCapabilities,
      create: () => ({}),
    } as unknown as CarrierControlFactory;
    const carriers = new CarrierRegistry(
      new Map([['carrier', { version: '1.0.0', factory: control }]]),
      resolve,
      'carrier',
    );
    expect((await carriers.forInboundRoute({})).carrierId).toBe('fixture');
    expect(
      (
        await carriers.forRelease({
          selections: { carrier: { pluginId: 'carrier', version: '1.0.0', config: {} } },
        })
      ).bindingId,
    ).toBe('env');
    await expect(
      carriers.forRelease({
        selections: { carrier: { pluginId: 'carrier', version: '2.0.0', config: {} } },
      }),
    ).rejects.toThrow('is not installed');
    await expect(carriers.forInboundRoute({ carrierPluginId: 'missing' })).rejects.toThrow(
      'not installed',
    );
  });
});
