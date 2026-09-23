import { describe, expect, it } from 'vitest';
import { AgentConfig, Cap, type MediaDuplex } from '@winsendotai/ovo-contracts';
import { compose, definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { ReleasePluginUnavailableError, selectSessionGraph } from '../src/select-session-graph.ts';

const service = (id: string, key: string) =>
  definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: [key],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(key, () => undefined);
    },
  );
const engine = (version: string, companions = {}) =>
  definePlugin(
    {
      id: 'fixture-engine',
      version,
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'fixture',
      provides: [`${Cap.engine}@2`],
      requires: [Cap.media, Cap.usage, Cap.transcripts],
      companions,
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: {
        turnDetection: ['provider'],
        bargeIn: true,
        dtmf: true,
        confirmedPlayback: true,
        ownsProviders: false,
        formats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
        consumesTurnDetector: false,
      },
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['engine@1'],
    } as never,
    (ctx) => {
      ctx.provide(Cap.engine as never, { start: async () => undefined } as never);
    },
  );
const transcriptCompanion = definePlugin(
  {
    id: 'fixture-companion',
    version: '1.2.0',
    contractVersion: 1,
    scope: 'session',
    provides: [Cap.transcripts],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
  },
  (ctx) => {
    ctx.provide(Cap.transcripts, () => undefined);
  },
);
const legacyStt = definePlugin(
  {
    id: 'fixture-stt',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'stt',
    provider: 'fixture-stt',
    provides: [`${Cap.stt}@2`],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
    capabilities: {
      languages: ['*'],
      interim: true,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
      inputFormats: [],
    },
    meters: [{ key: 'fixture-stt.audio', unit: 'audio_seconds', label: 'Audio', role: 'stt' }],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['stt@1'],
  } as never,
  () => undefined,
);
const media = {
  sessionId: 'session',
  carrierId: 'carrier',
  format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
  playbackEvidence: 'carrier-played',
} as MediaDuplex;
const usage = service('host-usage', Cap.usage);
const transcripts = service('host-transcripts', Cap.transcripts);
const unused = service('host-clock', Cap.clock);
const configured = (version = '1.0.0') => ({
  id: 'release',
  workspaceId: 'workspace',
  config: AgentConfig.parse({ name: 'announce', mode: 'announcement' }),
  plugins: [],
  selections: { engine: { pluginId: 'fixture-engine', version, config: {} } },
});
function input(version = '1.0.0') {
  const catalog = [
    engine('1.2.0', { [Cap.transcripts]: 'fixture-companion' }),
    transcriptCompanion,
  ];
  return {
    release: configured(version),
    registry: new PluginRegistry(catalog),
    hostServices: [usage, transcripts, unused],
    parent: [Cap.media, Cap.usage, Cap.transcripts],
    media,
    installedExtensions: { plugins: [], nativeHandlers: {} },
  };
}

describe('selected session graph', () => {
  it('enables input for a scripted announcement and passes call variables into the engine', () => {
    const selectedInput = input();
    selectedInput.release.config = AgentConfig.parse({
      name: 'scripted',
      mode: 'announcement',
      script: {
        start: 'question',
        nodes: [
          {
            id: 'question',
            prompt: 'Press one',
            transitions: [{ event: 'dtmf', matches: ['1'], to: 'done' }],
          },
          { id: 'done', prompt: 'Done', terminal: true },
        ],
      },
    });
    const selected = selectSessionGraph({
      ...selectedInput,
      sessionVariables: { callerName: 'Asha' },
    });
    expect(selected.rows.find((row) => row.id === 'fixture-engine')?.config?.session).toMatchObject(
      {
        inputEnabled: true,
        variables: { callerName: 'Asha' },
      },
    );
  });
  it('resolves same-major pins, prunes services and composes the actual session rows', async () => {
    const selected = selectSessionGraph(input());
    expect(selected.resolved.engine).toEqual({
      id: 'fixture-engine',
      version: '1.2.0',
      exact: false,
    });
    expect(selected.rows.map((row) => row.id)).toContain('host-usage');
    expect(selected.rows.map((row) => row.id)).toContain('host-transcripts');
    expect(selected.rows.map((row) => row.id)).not.toContain('host-clock');
    expect(selected.rows.map((row) => row.id)).not.toContain('fixture-companion');
    const engineRow = selected.rows.find((row) => row.id === 'fixture-engine')!;
    expect(engineRow.config?.session).toMatchObject({ mode: 'announcement', maxCallSeconds: 1800 });
    const behaviorRow = selected.rows.find(
      (row) => row.id === '@winsendotai/ovo-behavior-announcement',
    )!;
    expect(behaviorRow.config).toMatchObject({ workspaceId: 'workspace', sessionId: 'session' });
    const graph = await compose(selected.rows, selected.catalog, { scope: 'session' });
    expect(graph.get(Cap.behavior)).toBeDefined();
    await graph.dispose();
  });
  it('keeps transitive host services needed by another selected host service', () => {
    const selectedInput = input();
    const usageWithClock = definePlugin({ ...usage.manifest, requires: [Cap.clock] }, usage.apply);
    selectedInput.hostServices = [usageWithClock, transcripts, unused];
    const selected = selectSessionGraph(selectedInput);
    expect(selected.rows.map((row) => row.id)).toContain('host-clock');
  });
  it('resolves exact pins, rejects different majors and does not trust session keys from parent', () => {
    const exact = input('1.2.0');
    expect(selectSessionGraph(exact).resolved.engine.exact).toBe(true);
    const wrong = input('2.0.0');
    try {
      selectSessionGraph(wrong);
      throw new Error('expected unavailable pin');
    } catch (error) {
      expect(error).toBeInstanceOf(ReleasePluginUnavailableError);
      expect((error as ReleasePluginUnavailableError).code).toBe('release.plugin_unavailable');
    }
    const missingUsage = input();
    missingUsage.hostServices = [transcripts];
    expect(() => selectSessionGraph(missingUsage)).toThrow(/usage-sink|Missing required/);
  });
  it('adds the companion when the host does not provide its key', () => {
    const selectedInput = input();
    selectedInput.hostServices = [usage];
    const selected = selectSessionGraph(selectedInput);
    expect(selected.rows.map((row) => row.id)).toContain('fixture-companion');
  });
  it('resolves pre-selection releases unpinned through the installed default', () => {
    const selectedInput = input();
    const release = { ...selectedInput.release, selections: undefined };
    const selected = selectSessionGraph({
      ...selectedInput,
      release,
      defaults: { engine: 'fixture-engine' },
    });
    expect(selected.resolved.engine).toEqual({
      id: 'fixture-engine',
      version: '1.2.0',
      exact: false,
    });
  });
  it('uses legacy binding credentials without fabricating an invalid snapshot', () => {
    const selectedInput = input();
    const release = {
      ...selectedInput.release,
      selections: undefined,
      config: AgentConfig.parse({
        name: 'legacy',
        mode: 'announcement',
        providers: { stt: 'binding' },
      }),
      providerBindings: {
        stt: {
          id: 'binding',
          provider: 'fixture-stt',
          config: { model: 'legacy' },
          credentialId: 'credential',
        },
      },
    };
    const selected = selectSessionGraph({
      ...selectedInput,
      release,
      registry: new PluginRegistry([...selectedInput.registry.list(), legacyStt]),
      defaults: { engine: 'fixture-engine' },
    });
    expect(selected.rows.find((row) => row.id === 'fixture-stt')?.config).toMatchObject({
      binding: { model: 'legacy' },
      credentialRef: { credentialId: 'credential' },
    });
  });
});
