import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compose,
  enforcementMode,
  getViolationSink,
  setViolationSink,
  type PluginViolation,
} from '../src/index.ts';
import { v1Plugin, v2Plugin } from './support.ts';

const leaky = () =>
  v1Plugin('leaky', ['own'], [], (ctx) => {
    ctx.provide('own', 1);
    ctx.provide('leak', 2);
  });

afterEach(() => {
  setViolationSink(undefined);
  vi.unstubAllEnvs();
});

describe('violation sink and enforcement modes (§3.7)', () => {
  it('reports every violation to the installed sink', async () => {
    const seen: PluginViolation[] = [];
    const sink = (violation: PluginViolation) => void seen.push(violation);
    setViolationSink(sink);
    expect(getViolationSink()).toBe(sink);
    const composition = await compose([{ id: 'leaky' }], [leaky()]);
    expect(seen).toEqual([
      {
        pluginId: 'leaky',
        pluginVersion: '1.0.0',
        kind: 'provide-undeclared',
        key: 'leak',
        mode: 'warn',
        message: 'provide-undeclared: leaky provided leak',
      },
    ]);
    expect(composition.violations).toEqual(seen);
    expect(Object.isFrozen(seen[0])).toBe(true);
    await composition.dispose();
  });

  it('reports thrown violations too, and a failing sink never changes behavior', async () => {
    const sink = vi.fn(() => {
      throw new Error('sink down');
    });
    setViolationSink(sink);
    const composition = await compose([{ id: 'leaky' }], [leaky()]);
    expect(sink).toHaveBeenCalledTimes(1);
    await composition.dispose();
    const strict = v2Plugin({ id: 'strict' }, (ctx) => void ctx.provide('leak', 1));
    await expect(compose([{ id: 'strict' }], [strict])).rejects.toThrow('provide-undeclared');
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('defaults v1 to warn, honours OVO_PLUGIN_ENFORCEMENT and the option, and always enforces v2', async () => {
    const v1 = leaky().manifest;
    const v2 = v2Plugin({ id: 'v2' }).manifest;
    expect(enforcementMode(v1)).toBe('warn');
    expect(enforcementMode(v2, 'warn')).toBe('enforce');
    vi.stubEnv('OVO_PLUGIN_ENFORCEMENT', 'enforce');
    expect(enforcementMode(v1)).toBe('enforce');
    expect(enforcementMode(v1, 'warn')).toBe('warn');
    await expect(compose([{ id: 'leaky' }], [leaky()])).rejects.toThrow('provide-undeclared');
    vi.stubEnv('OVO_PLUGIN_ENFORCEMENT', 'bogus');
    expect(enforcementMode(v1)).toBe('warn');
  });
});
