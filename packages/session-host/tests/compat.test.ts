import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry, setGlibcProbe } from '@winsendotai/ovo-runtime';
import { validateSelections, type CompatInput } from '../src/compat/index.ts';
import {
  MULAW,
  UNREACHABLE,
  speech,
  carrier,
  data,
  catalog,
  fixture,
  withConfig,
  codes,
} from './compat-support.ts';

function proves(
  code: string,
  stage: 'release' | 'live' | 'test',
  bad: () => CompatInput,
  good: () => CompatInput = () => fixture(),
  severity: 'error' | 'warning' = [
    'legacy_release_unpinned',
    'stt_frame_size',
    'mode_llm_unused',
  ].includes(code)
    ? 'warning'
    : 'error',
) {
  it(`${code}: rejects broken input and accepts the valid counterpart`, () => {
    expect(validateSelections(bad(), stage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code, stage, severity, message: expect.any(String) }),
      ]),
    );
    expect(codes(good(), stage)).not.toContain(code);
  });
}
const edit = (
  slot: keyof typeof data,
  update: Record<string, unknown>,
  change: Record<string, Record<string, unknown>> = {},
) => {
  const input = fixture(change);
  input.selections = { ...input.selections, [slot]: { ...input.selections![slot], ...update } };
  return input;
};

afterEach(() => setGlibcProbe(undefined));
describe('every compatibility rule has a true negative', () => {
  proves('plugin_not_installed', 'release', () => edit('tts', { pluginId: 'missing' }));
  proves('plugin_version_not_installed', 'release', () => edit('tts', { version: '2.0.0' }));
  proves('plugin_unavailable', 'live', () => {
    setGlibcProbe(() => undefined);
    return fixture({ tts: { runtime: { native: 'glibc', egressHosts: [], modelLicences: [] } } });
  });
  proves('binding_missing', 'release', () =>
    edit('tts', { bindingId: undefined, binding: undefined }),
  );
  proves('binding_plugin_mismatch', 'release', () =>
    edit('tts', {
      binding: {
        provider: 'wrong',
        config: { model: 'ok' },
        credentialId: 'c',
        fingerprint: 'f',
        updatedAt: 'now',
      },
    }),
  );
  proves('binding_schema_invalid', 'release', () =>
    edit('tts', {
      binding: {
        provider: 'tts',
        config: { model: 7 },
        credentialId: 'c',
        fingerprint: 'f',
        updatedAt: 'now',
      },
    }),
  );
  proves(
    'secret_inline',
    'release',
    () => edit('tts', { config: { token: 'inline' } }, { tts: { secretFields: ['/token'] } }),
    () => fixture({ tts: { secretFields: ['/token'] } }),
  );
  proves('format_unreachable', 'live', () =>
    fixture({
      carrier: {
        capabilities: { ...carrier, media: { ...carrier.media, formats: [UNREACHABLE] } },
      },
    }),
  );
  proves('stt_frame_size', 'live', () => ({
    ...fixture({
      stt: {
        capabilities: {
          ...speech,
          inputFormats: [MULAW],
          frameMs: { min: 50, max: 1000, preferred: 100 },
        },
      },
    }),
    carrierFrameMs: 20,
  }));
  proves('language_unsupported', 'live', () => withConfig(fixture(), { language: 'fr-FR' }));
  proves('mode_requires_llm', 'live', () => {
    const input = fixture();
    input.selections = { ...input.selections, llm: undefined };
    return input;
  });
  proves('mode_llm_unused', 'live', () => withConfig(fixture(), { mode: 'announcement' }));
  proves('turn_signal_missing', 'live', () =>
    fixture({ stt: { capabilities: { ...speech, turnSignals: [], inputFormats: [MULAW] } } }),
  );
  proves('playback_evidence_insufficient', 'live', () =>
    withConfig(
      fixture({
        carrier: {
          capabilities: {
            ...carrier,
            media: { ...carrier.media, playbackEvidence: 'carrier-processed' },
          },
        },
      }),
      {
        tools: [
          {
            id: 'write',
            description: 'write',
            connector: 'native',
            inputSchema: {},
            effect: 'write',
            confirmation: true,
          },
        ],
      },
    ),
  );
  proves('engine_capability_missing', 'live', () => ({ ...fixture(), turnStrategy: 'smart-turn' }));
  proves('amd_unsupported', 'live', () => ({
    ...fixture({
      carrier: { capabilities: { ...carrier, control: { ...carrier.control, amd: 'none' } } },
    }),
    amd: true,
  }));
  proves('meter_uncovered', 'live', () => ({ ...fixture(), priceCards: {} }));
  proves('runtime_incompatible', 'live', () => ({
    ...fixture({ tts: { runtime: { native: 'glibc', egressHosts: [], modelLicences: [] } } }),
    glibc: false,
  }));
  proves('licence_unaccepted', 'live', () =>
    fixture({ tts: { runtime: { egressHosts: [], modelLicences: ['silero'] } } }),
  );
  proves('fixture_unavailable', 'test', () => ({ ...fixture(), fixturePluginIds: [] }));
  const mcpFixture = (removedAt: string | null) => {
    const input = withConfig(fixture(), {
      tools: [
        {
          id: 'lookup',
          description: 'lookup',
          connector: 'mcp',
          connectionId: 'conn',
          remoteName: 'lookup',
          inputSchema: {},
          effect: 'read',
        },
      ],
      allowedTools: ['lookup'],
    });
    input.discoveredMcpTools = [{ connectionId: 'conn', remoteName: 'lookup', removedAt }];
    return input;
  };
  proves(
    'mcp_tool_removed',
    'release',
    () => mcpFixture('now'),
    () => mcpFixture(null),
  );
  const closeStreamFixture = (attested: boolean) => {
    const input = fixture({
      carrier: {
        capabilities: { ...carrier, control: { ...carrier.control, hangup: 'close-stream' } },
      },
    });
    if (attested) input.selections!.carrier!.binding!.config.streamEndTerminatesCall = true;
    return input;
  };
  proves(
    'termination_unsupported',
    'live',
    () => closeStreamFixture(false),
    () => closeStreamFixture(true),
  );
  proves('legacy_release_unpinned', 'live', () => ({ ...fixture(), selections: undefined }));

  it('blocks confirmed writes when the engine or carrier selection is missing', () => {
    const confirmed = withConfig(fixture(), {
      tools: [
        {
          id: 'write',
          description: 'write',
          connector: 'native',
          inputSchema: {},
          effect: 'write',
          confirmation: true,
        },
      ],
    });
    confirmed.selections = { ...confirmed.selections, engine: undefined };
    expect(codes(confirmed, 'live')).toContain('playback_evidence_insufficient');
    confirmed.selections = {
      ...confirmed.selections,
      engine: fixture().selections!.engine,
      carrier: undefined,
    };
    expect(codes(confirmed, 'live')).toContain('playback_evidence_insufficient');
  });
  it('checks the actual inbound carrier instead of the release carrier', () => {
    const input = withConfig(fixture(), {
      tools: [
        {
          id: 'write',
          description: 'write',
          connector: 'native',
          inputSchema: {},
          effect: 'write',
          confirmation: true,
        },
      ],
    });
    input.registry = new PluginRegistry([
      ...input.registry.list(),
      ...catalog({
        carrier: {
          capabilities: { ...carrier, media: { ...carrier.media, playbackEvidence: 'none' } },
        },
      })
        .filter((row) => row.manifest.id === 'carrier')
        .map((row) =>
          definePlugin({ ...row.manifest, id: 'inbound-carrier' } as never, () => undefined),
        ),
    ]);
    input.actualCarrier = { pluginId: 'inbound-carrier', version: '1.0.0', config: {} };
    expect(codes(input, 'live')).toContain('playback_evidence_insufficient');
  });
  it('validates meter coverage for legacy selections and scripted announcements', () => {
    const legacy = fixture();
    legacy.selections = undefined;
    legacy.config = AgentConfig.parse({
      name: 'legacy',
      mode: 'announcement',
      providers: { telephony: 'old-carrier', tts: 'old-tts' },
    });
    legacy.defaults = { engine: 'engine' };
    legacy.legacyProviderBindings = {
      'old-carrier': {
        id: 'old-carrier',
        provider: 'carrier',
        pluginId: 'carrier',
        config: { model: 'ok' },
      },
      'old-tts': { id: 'old-tts', provider: 'tts', pluginId: 'tts', config: { model: 'ok' } },
    };
    legacy.priceCards = {};
    expect(validateSelections(legacy, 'live')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'meter_uncovered',
          slot: 'carrier',
          pluginId: 'carrier',
          field: 'carrier.usage',
        }),
        expect.objectContaining({
          code: 'meter_uncovered',
          slot: 'tts',
          pluginId: 'tts',
          field: 'tts.usage',
        }),
      ]),
    );
    const scripted = fixture();
    scripted.config = AgentConfig.parse({
      name: 'scripted',
      mode: 'announcement',
      script: { start: 'first', nodes: [{ id: 'first', prompt: 'Hello', terminal: true }] },
    });
    scripted.priceCards = { 'carrier.usage': {}, 'tts.usage': {}, 'llm.usage': {} };
    expect(validateSelections(scripted, 'live')).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'meter_uncovered', slot: 'stt' })]),
    );
  });

  it('finds inline secrets nested in the actual provider row config', () => {
    const bad = edit(
      'tts',
      {
        binding: {
          provider: 'tts',
          config: { model: 'ok', apiKey: 'plain' },
          credentialId: 'c',
          fingerprint: 'f',
          updatedAt: 'now',
        },
      },
      { tts: { secretFields: ['/binding/apiKey'] } },
    );
    expect(codes(bad, 'release')).toContain('secret_inline');
    const good = edit(
      'tts',
      {
        binding: {
          provider: 'tts',
          config: { model: 'ok', apiKey: { credentialRef: { credentialId: 'c' } } },
          credentialId: 'c',
          fingerprint: 'f',
          updatedAt: 'now',
        },
      },
      { tts: { secretFields: ['/binding/apiKey'] } },
    );
    expect(codes(good, 'release')).not.toContain('secret_inline');
  });
  it('validates the exact selected binding schema rather than the newest same-id version', () => {
    const input = fixture();
    const old = input.registry.get('tts')!;
    const newer = definePlugin(
      { ...old.manifest, version: '1.1.0', bindingSchema: { type: 'object' } } as never,
      () => undefined,
    );
    input.registry = new PluginRegistry([newer, ...input.registry.list()]);
    input.selections = {
      ...input.selections,
      tts: {
        ...input.selections!.tts!,
        binding: {
          provider: 'tts',
          config: {},
          credentialId: 'c',
          fingerprint: 'f',
          updatedAt: 't',
        },
      },
    };
    expect(codes(input, 'release')).toContain('binding_schema_invalid');
    input.selections.tts!.binding!.config.model = 'ok';
    expect(codes(input, 'release')).not.toContain('binding_schema_invalid');
  });

  it('acknowledgement removes weak playback blocker, and test calls warn for meters', () => {
    const input = withConfig(
      fixture({
        carrier: {
          capabilities: { ...carrier, media: { ...carrier.media, playbackEvidence: 'none' } },
        },
      }),
      {
        tools: [
          {
            id: 'write',
            description: 'write',
            connector: 'native',
            inputSchema: {},
            effect: 'write',
            confirmation: true,
          },
        ],
        voice: { textFilters: [], acknowledgements: ['weak-playback-evidence'] },
      },
    );
    expect(codes(input, 'live')).not.toContain('playback_evidence_insufficient');
    input.priceCards = {};
    const uncovered = validateSelections(input, 'test').filter(
      (issue) => issue.code === 'meter_uncovered',
    );
    expect(uncovered.length).toBeGreaterThan(0);
    expect(uncovered.every((issue) => issue.severity === 'warning')).toBe(true);
  });
});
