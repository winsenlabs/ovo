import { describe, expect, it } from 'vitest';
import {
  Cap,
  Manifest,
  ManifestV2,
  normalizeManifest,
  parseCapabilityEntry,
  type ManifestV2Input,
  type SpeechCapabilities,
} from '../src/index.ts';

const speech: SpeechCapabilities = {
  languages: ['en-IN'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: false,
};

const stt = (overrides: Partial<ManifestV2Input> = {}): ManifestV2Input => ({
  id: '@acme/ovo-stt-example',
  version: '1.2.0',
  contractVersion: 2,
  scope: 'session',
  kind: 'stt',
  provider: 'example',
  provides: ['ovo.stt@2'],
  capabilities: speech,
  meters: [
    {
      key: 'example.streaming-stt.audio_seconds',
      unit: 'audio_seconds',
      label: 'Audio',
      role: 'stt',
    },
  ],
  runtime: { egressHosts: ['api.example.com'], modelLicences: [] },
  conformance: ['stt@1'],
  ...overrides,
});

const issuePaths = (input: unknown) => {
  const parsed = Manifest.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
};

describe('manifest v1', () => {
  it('parses unchanged and upcasts to kind infra with no optional keys', () => {
    const v1 = Manifest.parse({
      id: 'example.reminder',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: ['example.reminder'],
      ui: { label: 'Reminder', panel: 'schema-form' },
    });
    expect(v1).toMatchObject({ requires: [], secretFields: [], configSchema: { type: 'object' } });
    expect(v1.ui).toEqual({ label: 'Reminder', panel: 'schema-form' });
    const normalized = normalizeManifest(v1);
    expect(normalized).toMatchObject({ contractVersion: 2, kind: 'infra', optional: [] });
    expect(normalized.provides).toEqual(['example.reminder']);
  });

  it('adds ovo.secret-resolver to optional when secret fields are declared', () => {
    const v1 = Manifest.parse({
      id: 'secretive',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: [],
      secretFields: ['/apiKey'],
    });
    expect(normalizeManifest(v1).optional).toEqual([Cap.secrets]);
    const declared = Manifest.parse({ ...v1, requires: [Cap.secrets] });
    expect(normalizeManifest(declared).optional).toEqual([]);
  });
});

describe('manifest v2', () => {
  it('parses a complete provider manifest with defaults and meters.when', () => {
    const parsed = ManifestV2.parse(
      stt({
        meters: [
          {
            key: 'example.streaming-stt.audio_seconds',
            unit: 'audio_seconds',
            label: 'Nova audio',
            role: 'stt',
            when: { field: 'model', in: ['nova-3'] },
          },
        ],
      }),
    );
    expect(parsed).toMatchObject({ requires: [], optional: [], secretFields: [] });
    expect(parsed.meters?.[0]?.when).toEqual({ field: 'model', in: ['nova-3'] });
    expect(normalizeManifest(parsed)).toBe(parsed);
  });

  it('requires kind, and rejects unknown contract versions', () => {
    const { kind: _kind, ...withoutKind } = stt();
    expect(issuePaths(withoutKind)).toContain('kind');
    expect(Manifest.safeParse({ ...stt(), contractVersion: 3 }).success).toBe(false);
  });

  it('requires provider, capabilities, runtime and conformance on engine, carrier, stt, tts and llm', () => {
    for (const kind of ['engine', 'carrier', 'stt', 'tts', 'llm'] as const) {
      const bare = {
        id: `bare-${kind}`,
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind,
        provides: [],
      };
      const paths = issuePaths(bare);
      expect(paths, kind).toEqual(
        expect.arrayContaining(['provider', 'capabilities', 'runtime', 'conformance']),
      );
    }
  });

  it('requires meters for carrier, stt, tts and llm but not for engines', () => {
    expect(issuePaths(stt({ meters: undefined }))).toEqual(['meters']);
    expect(issuePaths(stt({ meters: [] }))).toEqual(['meters']);
    const engine = stt({
      kind: 'engine',
      provides: ['ovo.voice-session-engine@2'],
      meters: undefined,
      conformance: ['engine@1'],
    });
    expect(issuePaths(engine)).toEqual([]);
  });

  it('requires a provider for vad and turn-detector', () => {
    for (const kind of ['vad', 'turn-detector'] as const) {
      const input = {
        id: kind,
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind,
        provides: [],
      };
      expect(issuePaths(input)).toEqual(['provider']);
      expect(issuePaths({ ...input, provider: 'default' })).toEqual([]);
    }
  });

  it('allows companions only on engines', () => {
    const companions = { [Cap.speech]: '@acme/ovo-engine-example/speech' };
    const engine = stt({
      kind: 'engine',
      provides: ['ovo.voice-session-engine@2'],
      meters: undefined,
      conformance: ['engine@1'],
      companions,
    });
    expect(ManifestV2.parse(engine).companions).toEqual(companions);
    expect(issuePaths(stt({ companions }))).toEqual(['companions']);
  });

  it('accepts ${key}@${major} entries and rejects malformed ones', () => {
    expect(issuePaths(stt({ requires: ['ovo.clock@1'], optional: ['ovo.vad'] }))).toEqual([]);
    expect(issuePaths(stt({ provides: ['ovo.stt@0'] }))).toContain('provides.0');
    expect(issuePaths(stt({ provides: ['ovo.stt@02'] }))).toContain('provides.0');
    expect(issuePaths(stt({ provides: ['ovo.stt@'] }))).toContain('provides.0');
    expect(issuePaths(stt({ provides: ['@2'] }))).toContain('provides.0');
    expect(issuePaths(stt({ provides: ['ovo stt'] }))).toContain('provides.0');
    expect(issuePaths(stt({ provides: [''] }))).toContain('provides.0');
    // Keys that contain '@' themselves (native-handler markers) stay declarable in v2.
    const marker = 'ovo.native-handlers:@acme/tools/native-handlers@1.2.3';
    expect(issuePaths(stt({ requires: [marker] }))).toEqual([]);
    expect(parseCapabilityEntry(marker)).toEqual({ key: marker });
    expect(parseCapabilityEntry('ovo.stt@2')).toEqual({ key: 'ovo.stt', major: 2 });
  });

  it('keeps LlmCapabilities and carrier capabilities as declared objects', () => {
    const llm = ManifestV2.parse(
      stt({
        kind: 'llm',
        provides: ['ovo.inference'],
        capabilities: { tools: true, streaming: true },
        meters: [
          {
            key: 'example.inference.output_tokens',
            unit: 'output_tokens',
            label: 'Output',
            role: 'llm',
          },
        ],
        conformance: ['llm@1'],
      }),
    );
    expect(llm.capabilities).toEqual({ tools: true, streaming: true });
    expect(issuePaths(stt({ capabilities: 'fast' as never }))).toContain('capabilities');
  });
});
