import { describe, it, expect } from 'vitest';
import { compose, composeEntries, definePlugin, resolveGraph } from '../src/index.ts';
import type { Manifest } from '@winsendotai/ovo-contracts';
const manifest = (id: string, provides: string[] = [], requires: string[] = []): Manifest => ({
  id,
  version: '1.0.0',
  contractVersion: 1,
  scope: 'session',
  provides,
  requires,
  configSchema: { type: 'object' },
  secretFields: [],
});
describe('DeepSeek-derived OVO composition', () => {
  it('uses ordered upstream profile patches without mutating a previous release', () => {
    const layers = [
      [{ insert: [{ id: 'voice', name: 'voice', config: { voice: 'old' } }] }],
      [{ id: 'voice', config: { voice: 'new' } }],
    ];
    const entries = composeEntries(layers);
    expect(entries[0]?.config).toEqual({ voice: 'new' });
    expect(layers[0]?.[0]).toEqual({
      insert: [{ id: 'voice', name: 'voice', config: { voice: 'old' } }],
    });
    expect(() =>
      composeEntries([[{ id: 'missing', config: {} }]], (m) => {
        throw new Error(m);
      }),
    ).toThrow('not found');
  });
  it('validates every plugin config before allocating any sibling resource', async () => {
    let started = 0;
    const base = manifest('configured', ['configured']);
    base.configSchema = {
      type: 'object',
      required: ['endpoint'],
      properties: { endpoint: { type: 'string' } },
      additionalProperties: false,
    };
    const configured = definePlugin(base, (ctx) => {
      started++;
      ctx.provide('configured', {});
    });
    await expect(
      compose([{ id: 'configured', config: { endpoint: 12 } }], [configured]),
    ).rejects.toThrow('Invalid config');
    expect(started).toBe(0);
  });
  it('replaces engine through composition and pins existing calls', async () => {
    const first = definePlugin(manifest('engine-v1', ['engine']), (ctx) => {
      ctx.provide('engine', { version: 1 });
    });
    const second = definePlugin(manifest('engine-v2', ['engine']), (ctx) => {
      ctx.provide('engine', { version: 2 });
    });
    const a = await compose([{ id: 'engine-v1' }], [first, second]);
    const b = await compose([{ id: 'engine-v2' }], [first, second]);
    expect(a.ctx.get('engine')).toEqual({ version: 1 });
    expect(b.ctx.get('engine')).toEqual({ version: 2 });
    await b.dispose();
    expect(a.ctx.get('engine')).toEqual({ version: 1 });
    await a.dispose();
  });
  it('rejects missing, ambiguous and cyclic graphs before effects', () => {
    const missing = definePlugin(manifest('consumer', [], ['absent']), () => {});
    expect(() => resolveGraph([{ id: 'consumer' }], [missing])).toThrow('Missing service');
    const a = definePlugin(manifest('a', ['a'], ['b']), () => {});
    const b = definePlugin(manifest('b', ['b'], ['a']), () => {});
    expect(() => resolveGraph([{ id: 'a' }, { id: 'b' }], [a, b])).toThrow('cycle');
    const c = definePlugin(manifest('c', ['a']), () => {});
    expect(() => resolveGraph([{ id: 'a' }, { id: 'c' }], [a, c])).toThrow('Ambiguous');
  });
  it('rolls back partial initialization exactly once', async () => {
    const cleaned: string[] = [];
    const a = definePlugin(manifest('a', ['a']), (ctx) => {
      ctx.provide('a', {});
      ctx.effect(() => () => {
        cleaned.push('a');
      });
    });
    const b = definePlugin(manifest('b', [], ['a']), (ctx) => {
      ctx.effect(() => () => {
        cleaned.push('b');
      });
      throw new Error('startup failure');
    });
    await expect(compose([{ id: 'b' }, { id: 'a' }], [a, b])).rejects.toThrow('startup failure');
    expect(cleaned.sort()).toEqual(['a', 'b']);
  });
  it('isolates configuration and joins concurrent disposal', async () => {
    const cleaned: string[] = [];
    const plugin = definePlugin(manifest('state', ['state']), (ctx, config) => {
      ctx.provide('state', config);
      ctx.effect(() => async () => {
        await Promise.resolve();
        cleaned.push(String(config.id));
      });
    });
    const rows = [{ id: 'state', config: { id: 'a' } }];
    const a = await compose(rows, [plugin]);
    rows[0]!.config.id = 'changed';
    const b = await compose([{ id: 'state', config: { id: 'b' } }], [plugin]);
    expect(a.ctx.get('state')).toEqual({ id: 'a' });
    expect(b.ctx.get('state')).toEqual({ id: 'b' });
    await Promise.all([a.dispose(), a.dispose(), b.dispose()]);
    expect(cleaned.sort()).toEqual(['a', 'b']);
  });
  it('refuses a false advertised capability and cleans up', async () => {
    let cleaned = 0;
    const liar = definePlugin(manifest('liar', ['missing']), (ctx) => {
      ctx.effect(() => () => {
        cleaned++;
      });
    });
    await expect(compose([{ id: 'liar' }], [liar])).rejects.toThrow('did not provide');
    expect(cleaned).toBe(1);
  });
});
