import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cap, HOST_SESSION_SERVICES } from '@winsendotai/ovo-contracts';
import { definePlugin, setGlibcProbe, validateGraph } from '../src/index.ts';
import { engineManifest, v1Plugin, v2Plugin } from './support.ts';

afterEach(() => setGlibcProbe(undefined));

describe('validateGraph (§3.5)', () => {
  it('resolves and validates a session graph without ever calling apply', () => {
    const apply = vi.fn();
    const engine = definePlugin(
      engineManifest({
        id: 'engine',
        requires: ['ovo.behavior', Cap.media, Cap.usage, Cap.clock],
        optional: [Cap.net],
        configSchema: {
          type: 'object',
          properties: { session: { type: 'object' } },
          additionalProperties: false,
        },
      }) as never,
      apply,
    );
    const behavior = v1Plugin('behavior', ['ovo.behavior'], [], apply);
    const result = validateGraph(
      [{ id: 'engine', config: { session: {} } }, { id: 'behavior' }],
      [engine, behavior],
      { scope: 'session', parentKeys: [...HOST_SESSION_SERVICES, Cap.net] },
    );
    expect(result.issues).toEqual([]);
    expect(result.ordered.map((p) => p.manifest.id)).toEqual(['behavior', 'engine']);
    expect(apply).not.toHaveBeenCalled();
    const withoutHost = validateGraph([{ id: 'engine' }, { id: 'behavior' }], [engine, behavior]);
    expect(withoutHost.issues).toEqual([
      { code: 'graph_invalid', message: `Missing service ${Cap.media} for engine` },
    ]);
  });

  it('reports every scope, kind, secret and config issue instead of throwing', () => {
    const processPlugin = v1Plugin('process-only', [], [], () => undefined, { scope: 'process' });
    const engine = definePlugin(
      engineManifest({ id: 'engine', companions: { [Cap.speech]: 'engine-speech' } }) as never,
      () => undefined,
    );
    const secretive = v1Plugin('secretive', [], [], () => undefined, {
      secretFields: ['/apiKey'],
      configSchema: {
        type: 'object',
        required: ['region'],
        properties: { region: { type: 'string' } },
      },
    });
    const fixture = v2Plugin({ id: 'fixture', kind: 'fixture' });
    const { issues } = validateGraph(
      [
        { id: 'process-only' },
        { id: 'engine' },
        { id: 'secretive', config: { apiKey: 'sk-live' } },
        { id: 'fixture' },
      ],
      [processPlugin, engine, secretive, fixture],
      { scope: 'session' },
    );
    expect(issues.map((issue) => [issue.code, issue.pluginId])).toEqual([
      ['scope_mismatch', 'process-only'],
      ['kind_rule', 'engine'],
      ['fixture_disabled', 'fixture'],
      ['secret_inline', 'secretive'],
      ['config_invalid', 'secretive'],
    ]);
    expect(issues[1]!.message).toContain('companion engine-speech@1.0.0');
    const fixturesOn = validateGraph([{ id: 'fixture' }], [fixture], { fixtures: true });
    expect(fixturesOn.issues).toEqual([]);
  });

  it('accepts engine companions at the same version only', () => {
    const engine = definePlugin(
      engineManifest({
        id: 'engine',
        version: '1.2.0',
        companions: { [Cap.speech]: 'speech' },
      }) as never,
      () => undefined,
    );
    const stale = v2Plugin({ id: 'speech', version: '1.1.0', provides: [Cap.speech] });
    expect(validateGraph([{ id: 'engine' }], [engine, stale]).issues).toMatchObject([
      { code: 'kind_rule' },
    ]);
    const current = v2Plugin({ id: 'speech', version: '1.2.0', provides: [Cap.speech] });
    expect(validateGraph([{ id: 'engine' }], [engine, current]).issues).toEqual([]);
  });

  it('reports plugins that cannot run here', () => {
    setGlibcProbe(() => undefined);
    const native = v2Plugin({
      id: 'native',
      runtime: { native: 'glibc', egressHosts: [], modelLicences: [] },
    });
    expect(validateGraph([{ id: 'native' }], [native]).issues).toMatchObject([
      { code: 'plugin_unavailable', pluginId: 'native' },
    ]);
  });
});
