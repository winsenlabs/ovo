import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { PluginPinError, PluginRegistry, definePlugin, setGlibcProbe } from '../src/index.ts';
import { engineManifest, sttManifest, v1Plugin, v2Plugin } from './support.ts';

afterEach(() => setGlibcProbe(undefined));

const engine = (version: string, companions?: Record<string, string>) =>
  definePlugin(engineManifest({ id: 'engine', version, companions }) as never, () => undefined);
const stt = definePlugin(
  sttManifest({
    id: 'stt',
    version: '1.4.0',
    bindingSchema: {
      type: 'object',
      required: ['model'],
      properties: { model: { type: 'string' }, streamEndTerminatesCall: { const: true } },
    },
  }) as never,
  () => undefined,
);
const catalog = [
  engine('1.0.0'),
  engine('1.2.0', { [Cap.speech]: 'engine-speech' }),
  engine('2.0.0'),
  v2Plugin({ id: 'engine-speech', version: '1.2.0', provides: [Cap.speech] }),
  v1Plugin('behavior', ['ovo.behavior']),
  stt,
];

const pinError = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof PluginPinError ? error.code : String(error);
  }
  return 'no error';
};

describe('PluginRegistry (§3.9)', () => {
  const registry = new PluginRegistry(catalog);

  it('lists, resolves and gets installed plugins', () => {
    expect(registry.list('engine').map((p) => p.manifest.version)).toEqual([
      '2.0.0',
      '1.2.0',
      '1.0.0',
    ]);
    expect(registry.list('infra').map((p) => p.manifest.id)).toEqual(['engine-speech', 'behavior']);
    expect(registry.list()).toHaveLength(6);
    expect(registry.resolve('stt', 'fixture-stt')).toBe(stt);
    expect(registry.resolve('stt', 'stt')).toBe(stt);
    expect(() => registry.resolve('tts', 'fixture-stt')).toThrow('No installed tts plugin');
    expect(registry.get('engine')?.manifest.version).toBe('2.0.0');
    expect(registry.get('engine', '1.0.0')?.manifest.version).toBe('1.0.0');
    expect(registry.get('engine', '9.9.9')).toBeUndefined();
  });

  it('resolves pins exactly, else to the newest same-major version, never across majors', () => {
    expect(registry.resolvePin('engine', '1.0.0')).toMatchObject({ exact: true });
    expect(registry.resolvePin('engine', '1.0.0').definition.manifest.version).toBe('1.0.0');
    const sameMajor = registry.resolvePin('engine', '1.1.0');
    expect(sameMajor.exact).toBe(false);
    expect(sameMajor.definition.manifest.version).toBe('1.2.0');
    expect(pinError(() => registry.resolvePin('engine', '3.0.0'))).toBe(
      'plugin_version_not_installed',
    );
    expect(pinError(() => registry.resolvePin('missing', '1.0.0'))).toBe('plugin_not_installed');
  });

  it('keeps behaviors exact and lets engine companions follow the same-major rule', () => {
    expect(registry.resolvePin('behavior', '1.0.0').exact).toBe(true);
    expect(pinError(() => registry.resolvePin('behavior', '1.0.1'))).toBe(
      'plugin_version_not_installed',
    );
    const companion = registry.resolvePin('engine-speech', '1.0.0');
    expect(companion).toMatchObject({ exact: false });
    expect(companion.definition.manifest.version).toBe('1.2.0');
  });

  it('validates bindings with a non-strict Ajv against bindingSchema', () => {
    expect(
      registry.validateBinding('stt', { model: 'fast', streamEndTerminatesCall: true }),
    ).toEqual({ ok: true });
    const invalid = registry.validateBinding('stt', { streamEndTerminatesCall: false });
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.errors).toContain('model');
    expect(registry.validateBinding('behavior', { anything: 1 })).toEqual({ ok: true });
    expect(registry.validateBinding('missing', {})).toEqual({
      ok: false,
      errors: 'missing is not installed',
    });
  });

  it('treats zod string formats in binding schemas as annotations, without warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const carrier = v2Plugin({
        id: 'formats',
        bindingSchema: {
          type: 'object',
          properties: { callbackBase: { type: 'string', format: 'uri' } },
        },
      });
      const formats = new PluginRegistry([carrier]);
      expect(formats.validateBinding('formats', { callbackBase: 'https://x.test' })).toEqual({
        ok: true,
      });
      expect(formats.validateBinding('formats', { callbackBase: 7 }).ok).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('projects a JSON-safe public view with kinds and availability', () => {
    const projected = registry.project();
    expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
    expect(projected.find((p) => p.id === 'behavior')).toMatchObject({
      kind: 'infra',
      optional: [],
      available: true,
    });
    expect(projected.find((p) => p.id === 'stt')).toMatchObject({
      kind: 'stt',
      provider: 'fixture-stt',
    });
    const functions = (value: unknown): boolean =>
      typeof value === 'function' ||
      (!!value && typeof value === 'object' && Object.values(value).some(functions));
    expect(functions(projected)).toBe(false);
  });

  it('marks plugins that fail runtime checks unavailable instead of throwing', () => {
    setGlibcProbe(() => undefined);
    const native = v2Plugin({
      id: 'native',
      runtime: { native: 'glibc', egressHosts: [], modelLicences: [] },
    });
    const withNative = new PluginRegistry([...catalog, native]);
    expect(withNative.unavailable()).toEqual([
      { id: 'native', version: '1.0.0', reason: 'native needs glibc, and this runtime has none' },
    ]);
    expect(withNative.project().find((p) => p.id === 'native')).toMatchObject({ available: false });
    expect(pinError(() => withNative.resolvePin('native', '1.0.0'))).toBe('plugin_unavailable');
    expect(registry.unavailable()).toEqual([]);
  });
});
