import { afterEach, describe, expect, it } from 'vitest';
import {
  PluginRegistry,
  compose,
  glibcVersion,
  setGlibcProbe,
  unavailableReason,
} from '../src/index.ts';
import { v2Plugin } from './support.ts';

afterEach(() => setGlibcProbe(undefined));

const native = () =>
  v2Plugin(
    {
      id: 'native',
      provides: ['native.service'],
      runtime: { native: 'glibc', egressHosts: [], modelLicences: [] },
    },
    (ctx) => void ctx.provide('native.service', {}),
  );

describe('glibc-native plugins (§3.8)', () => {
  it('reads glibc from process.report without throwing', () => {
    const version = glibcVersion();
    expect(version === undefined || /^\d+\.\d+/.test(version)).toBe(true);
  });

  it('marks a glibc plugin unavailable when the runtime has none, and refuses to compose it', async () => {
    setGlibcProbe(() => undefined);
    expect(unavailableReason(native().manifest)).toBe(
      'native needs glibc, and this runtime has none',
    );
    const registry = new PluginRegistry([native()]);
    expect(registry.unavailable()).toHaveLength(1);
    await expect(compose([{ id: 'native' }], [native()])).rejects.toThrow(
      'Plugin native is unavailable',
    );
  });

  it('makes it available on a glibc runtime and caches the probe', async () => {
    let calls = 0;
    setGlibcProbe(() => {
      calls++;
      return '2.36';
    });
    expect(unavailableReason(native().manifest)).toBeUndefined();
    expect(new PluginRegistry([native()]).unavailable()).toEqual([]);
    const composition = await compose([{ id: 'native' }], [native()]);
    await composition.dispose();
    expect(calls).toBe(1);
  });

  it('ignores the probe for plugins without native code', () => {
    setGlibcProbe(() => {
      throw new Error('never called');
    });
    expect(unavailableReason(v2Plugin({ id: 'pure' }).manifest)).toBeUndefined();
  });
});
