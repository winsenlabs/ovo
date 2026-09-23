import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentConfig,
  Cap,
  type AudioFormat,
  type ReleaseSelections,
} from '@winsendotai/ovo-contracts';
import {
  definePlugin,
  PluginRegistry,
  setGlibcProbe,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import { validateSelections, type CompatInput } from '../src/compat/index.ts';

const MULAW: AudioFormat = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
const PCM: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };
const UNREACHABLE: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 };
const speech = {
  languages: ['en-IN'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: false,
};
const carrier = {
  carrierId: 'fixture',
  media: {
    formats: [MULAW],
    playbackEvidence: 'carrier-played',
    clear: true,
    clearFlushesMarkers: true,
    dtmf: true,
    queryOnMediaUrl: false,
  },
  control: {
    callIdTiming: 'at-dial',
    streamParams: 'at-dial',
    streamCallIdMatchesDial: true,
    cancelBeforeAnswer: true,
    handoff: [],
    amd: 'async',
    maxDuration: true,
    reconcile: 'by-call-id',
    hangup: 'rest',
  },
  continuation: 'none',
  webhookAuth: 'hmac-signature',
  pacing: { cps: 1 },
};
const engine = {
  turnDetection: ['provider'],
  bargeIn: true,
  dtmf: true,
  confirmedPlayback: true,
  ownsProviders: false,
  formats: [MULAW],
  consumesTurnDetector: false,
};
const data = {
  engine: {
    kind: 'engine',
    provider: 'engine',
    provides: [Cap.engine],
    capabilities: engine,
    conformance: ['engine@1'],
  },
  carrier: {
    kind: 'carrier',
    provider: 'carrier',
    provides: [Cap.carrierControl],
    capabilities: carrier,
    conformance: ['carrier@1'],
  },
  stt: {
    kind: 'stt',
    provider: 'stt',
    provides: [Cap.stt],
    capabilities: { ...speech, inputFormats: [MULAW] },
    conformance: ['stt@1'],
  },
  tts: {
    kind: 'tts',
    provider: 'tts',
    provides: [Cap.tts],
    capabilities: { ...speech, outputFormats: [PCM] },
    conformance: ['tts@1'],
  },
  llm: {
    kind: 'llm',
    provider: 'llm',
    provides: [Cap.inference],
    capabilities: { tools: true, streaming: true },
    conformance: ['llm@1'],
  },
} as const;
function catalog(change: Record<string, Record<string, unknown>> = {}) {
  return Object.entries(data).map(([id, row]) =>
    definePlugin(
      {
        id,
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        ...row,
        meters:
          id === 'engine'
            ? undefined
            : [{ key: `${id}.usage`, unit: 'audio_seconds', label: 'Usage', role: id }],
        runtime: { egressHosts: [], modelLicences: [] },
        bindingSchema: {
          type: 'object',
          properties: { model: { type: 'string' } },
          required: ['model'],
        },
        ...change[id],
      } as never,
      () => undefined,
    ),
  );
}
function fixture(change: Record<string, Record<string, unknown>> = {}): CompatInput {
  const definitions = catalog(change);
  const snapshot = (id: string) => ({
    provider: id,
    config: { model: 'ok' },
    credentialId: 'credential',
    fingerprint: 'fingerprint',
    updatedAt: 'today',
  });
  const selections = Object.fromEntries(
    Object.keys(data).map((id) => [
      id,
      {
        pluginId: id,
        version: '1.0.0',
        ...(id === 'engine' ? {} : { bindingId: id, binding: snapshot(id) }),
        config: {},
      },
    ]),
  ) as ReleaseSelections;
  return {
    config: AgentConfig.parse({ name: 'fixture', mode: 'context', language: 'en-IN' }),
    selections,
    registry: new PluginRegistry(definitions),
    carrierFrameMs: 100,
    turnStrategy: 'provider',
    amd: false,
    glibc: true,
    acceptedLicences: [],
    priceCards: { 'carrier.usage': {}, 'stt.usage': {}, 'tts.usage': {}, 'llm.usage': {} },
    fixturePluginIds: ['carrier', 'stt', 'tts', 'llm'],
  };
}
function withConfig(input: CompatInput, raw: Record<string, unknown>) {
  input.config = AgentConfig.parse({ ...input.config, ...raw });
  return input;
}
function codes(input: CompatInput, stage: 'release' | 'live' | 'test') {
  return validateSelections(input, stage).map((entry) => entry.code);
}
function proves(
  code: string,
  stage: 'release' | 'live' | 'test',
  bad: () => CompatInput,
  good: () => CompatInput = () => fixture(),
) {
  it(`${code}: rejects broken input and accepts the valid counterpart`, () => {
    expect(codes(bad(), stage)).toContain(code);
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
  proves('mcp_tool_removed', 'release', () => {
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
    input.discoveredMcpTools = [{ connectionId: 'conn', remoteName: 'lookup', removedAt: 'now' }];
    return input;
  });
  proves('termination_unsupported', 'live', () =>
    fixture({
      carrier: {
        capabilities: { ...carrier, control: { ...carrier.control, hangup: 'close-stream' } },
      },
    }),
  );
  proves('legacy_release_unpinned', 'live', () => ({ ...fixture(), selections: undefined }));

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
