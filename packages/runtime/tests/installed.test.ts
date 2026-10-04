import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FixtureTemplate, NetFixtureScript } from '@winsendotai/ovo-contracts';
import {
  createNativeHandlerMarker,
  definePlugin,
  loadInstalledSessionExtensions,
  nativeHandlerMarkerService,
  setGlibcProbe,
} from '../src/index.ts';
import { sttManifest, v1Plugin } from './support.ts';

afterEach(() => setGlibcProbe(undefined));

const script: NetFixtureScript = {
  host: 'stt.example.test',
  source: 'https://docs.example.test/streaming',
  retrieved: '2026-09-22',
  steps: [{ expect: 'ws-open', url: /stt\.example\.test/ }, { send: '{"type":"Results"}' }],
};
const template: FixtureTemplate = (input) => [
  { ...script, steps: input.turns.map((turn) => ({ send: JSON.stringify({ say: turn.say }) })) },
];
const sttPlugin = (id: string, provider = 'fixture-stt') =>
  definePlugin(sttManifest({ id, provider }) as never, () => undefined);

const load = (modules: Record<string, unknown>) => async (name: string) => {
  if (!(name in modules)) throw new Error('not installed');
  return modules[name];
};

describe('installed extension loader (§3.9)', () => {
  it('loads v2 plugins with their fixtures and fixture templates', async () => {
    const extensions = await loadInstalledSessionExtensions(
      '["@acme/ovo-stt-fixture"]',
      load({
        '@acme/ovo-stt-fixture': {
          plugins: [sttPlugin('@acme/ovo-stt-fixture')],
          fixtures: { '@acme/ovo-stt-fixture': [script] },
          fixtureTemplates: { '@acme/ovo-stt-fixture': template },
        },
      }),
    );
    expect(extensions.plugins.map((p) => [p.manifest.id, p.manifest.contractVersion])).toEqual([
      ['@acme/ovo-stt-fixture', 2],
    ]);
    expect(extensions.fixtures).toEqual({ '@acme/ovo-stt-fixture': [script] });
    const rendered = extensions.fixtureTemplates!['@acme/ovo-stt-fixture']!({
      format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
      language: 'en-IN',
      sessionId: 's-1',
      turns: [{ atMs: 0, say: 'yes' }],
    });
    expect(rendered[0]!.steps).toEqual([{ send: '{"say":"yes"}' }]);
    expect(extensions.unavailable).toEqual([]);
  });

  it('rejects duplicate ids, duplicate session providers and malformed fixture exports', async () => {
    const twice = { plugins: [v1Plugin('same', [])] };
    await expect(
      loadInstalledSessionExtensions('["a","b"]', load({ a: twice, b: twice })),
    ).rejects.toThrow('Duplicate installed plugin identifier');
    await expect(
      loadInstalledSessionExtensions(
        '["a","b"]',
        load({ a: { plugins: [sttPlugin('stt-a')] }, b: { plugins: [sttPlugin('stt-b')] } }),
      ),
    ).rejects.toThrow('Duplicate installed stt provider fixture-stt');
    await expect(
      loadInstalledSessionExtensions('["a"]', load({ a: { fixtures: { x: 'not-a-list' } } })),
    ).rejects.toThrow('Invalid or duplicate installed fixtures for x');
    await expect(
      loadInstalledSessionExtensions('["a"]', load({ a: { fixtureTemplates: { x: {} } } })),
    ).rejects.toThrow('fixture template');
    await expect(
      loadInstalledSessionExtensions(
        '["a","b"]',
        load({ a: { fixtures: { x: [] } }, b: { fixtures: { x: [] } } }),
      ),
    ).rejects.toThrow('Invalid or duplicate installed fixtures for x');
  });

  it('loads two same-vendor text filters by distinct plugin id', async () => {
    const filter = (id: string) =>
      definePlugin(
        {
          id,
          version: '1.0.0',
          contractVersion: 2,
          kind: 'text-filter',
          provider: 'ovo',
          scope: 'session',
          provides: ['ovo.text-filter@1'],
          requires: [],
          configSchema: { type: 'object' },
          secretFields: [],
        },
        () => undefined,
      );
    const loaded = await loadInstalledSessionExtensions(
      '["a"]',
      load({ a: { plugins: [filter('markdown'), filter('url')] } }),
    );
    expect(loaded.plugins.map((plugin) => plugin.manifest.id)).toEqual(['markdown', 'url']);
  });

  it('parses v2 manifests and refuses invalid ones', async () => {
    const invalid = {
      manifest: { ...sttManifest({ id: 'bad' }), meters: [] },
      apply: () => undefined,
    };
    await expect(
      loadInstalledSessionExtensions('["a"]', load({ a: { plugins: [invalid] } })),
    ).rejects.toThrow('meters');
  });

  it('marks glibc-native plugins unavailable without throwing', async () => {
    setGlibcProbe(() => undefined);
    const native = definePlugin(
      sttManifest({
        id: 'native-stt',
        runtime: { native: 'glibc', egressHosts: [], modelLicences: [] },
      }) as never,
      () => undefined,
    );
    const extensions = await loadInstalledSessionExtensions(
      '["a"]',
      load({ a: { plugins: [native] } }),
    );
    expect(extensions.plugins).toHaveLength(1);
    expect(extensions.unavailable).toEqual([
      {
        id: 'native-stt',
        version: '1.0.0',
        reason: 'native-stt needs glibc, and this runtime has none',
      },
    ]);
  });

  it('keeps exact native-handler package identity', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const extensions = await loadInstalledSessionExtensions(
      '["@acme/tools"]',
      load({
        '@acme/tools': {
          nativeHandlers: {
            package: { name: '@acme/tools', version: '1.0.0' },
            plugin: { id: '@acme/tools/native-handlers', version: '1.0.0' },
            handlers: { lookup: handler },
          },
        },
      }),
    );
    expect(extensions.nativeHandlers.lookup).toBe(handler);
    const [pkg] = extensions.nativeHandlerPackages!;
    expect(extensions.plugins[0]!.manifest.provides).toEqual([nativeHandlerMarkerService(pkg!)]);
    expect(createNativeHandlerMarker(pkg!).manifest.id).toBe('@acme/tools/native-handlers');
    await expect(loadInstalledSessionExtensions('not json')).rejects.toThrow('JSON array');
  });
});
