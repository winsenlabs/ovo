import { describe, expect, it } from 'vitest';
import type { BackgroundTask } from '@winsendotai/ovo-contracts';
import { compose, resolveGraph, type PluginContext } from '../src/index.ts';
import { v1Plugin, v2Plugin } from './support.ts';

const task = (id: string): BackgroundTask => ({
  id,
  intervalMs: 1000,
  tick: async () => undefined,
});
const taskPlugin = (id: string, provider?: string, started?: string[]) =>
  v2Plugin({ id, provider, scope: 'process', provides: ['ovo.background-task'] }, (ctx) => {
    started?.push(id);
    ctx.provide('ovo.background-task', task(provider ?? id));
  });

describe('cardinality many (§3.4)', () => {
  it('keeps two text filters from one provider distinct in ctx.all', async () => {
    const filter = (id: string) =>
      v2Plugin(
        {
          id,
          kind: 'text-filter',
          provider: 'ovo',
          provides: ['ovo.text-filter@1'],
        },
        (ctx) => void ctx.provide('ovo.text-filter', { id }),
      );
    let keys: string[] = [];
    const reader = v2Plugin({ id: 'reader', requires: ['ovo.text-filter@1'] }, (ctx) => {
      keys = [...(ctx as unknown as PluginContext).all('ovo.text-filter').keys()];
    });
    const plugins = [filter('markdown'), filter('url'), reader];
    const composed = await compose(
      plugins.map((plugin) => ({ id: plugin.manifest.id })),
      plugins,
    );
    expect(keys.sort()).toEqual(['markdown', 'url']);
    await composed.dispose();
  });
  it('lets several providers of a many-key compose, qualified by provider or id', async () => {
    const started: string[] = [];
    let seen: ReadonlyMap<string, unknown> | undefined;
    const runner = v2Plugin(
      { id: 'runner', scope: 'process', requires: ['ovo.background-task'] },
      (ctx) => {
        started.push('runner');
        seen = (ctx as unknown as PluginContext).all('ovo.background-task');
      },
    );
    const catalog = [
      runner,
      taskPlugin('sweeper-plugin', 'sweeper', started),
      taskPlugin('reconciler', undefined, started),
    ];
    const composition = await compose(
      [{ id: 'runner' }, { id: 'sweeper-plugin' }, { id: 'reconciler' }],
      catalog,
      { scope: 'process' },
    );
    // A plugin that requires a many-key depends on ALL of its providers.
    expect(started).toEqual(['sweeper-plugin', 'reconciler', 'runner']);
    expect([...seen!.keys()].sort()).toEqual(['reconciler', 'sweeper']);
    expect((seen!.get('sweeper') as BackgroundTask).id).toBe('sweeper');
    expect(Object.isFrozen(seen)).toBe(true);
    expect(() => (seen as Map<string, unknown>).set('x', 1)).toThrow('read-only');
    expect([...composition.all('ovo.background-task').keys()].sort()).toEqual([
      'reconciler',
      'sweeper',
    ]);
    expect(composition.ctx.get('ovo.background-task:sweeper')).toMatchObject({ id: 'sweeper' });
    await composition.dispose();
  });

  it('allows zero providers of a required many-key', async () => {
    let size = -1;
    const runner = v2Plugin({ id: 'runner', requires: ['ovo.background-task'] }, (ctx) => {
      size = (ctx as unknown as PluginContext).all('ovo.background-task').size;
    });
    const composition = await compose([{ id: 'runner' }], [runner]);
    expect(size).toBe(0);
    await composition.dispose();
  });

  it('rejects two providers with the same qualifier, and keeps Ambiguous for one-keys', () => {
    const a = taskPlugin('a', 'same');
    const b = taskPlugin('b', 'same');
    expect(() => resolveGraph([{ id: 'a' }, { id: 'b' }], [a, b])).toThrow(
      'Ambiguous service: ovo.background-task:same',
    );
    const clockA = v1Plugin('clock-a', ['ovo.clock']);
    const clockB = v1Plugin('clock-b', ['ovo.clock']);
    expect(() => resolveGraph([{ id: 'clock-a' }, { id: 'clock-b' }], [clockA, clockB])).toThrow(
      'Ambiguous service: ovo.clock',
    );
  });

  it('refuses get() on a many-key', async () => {
    const reader = v2Plugin({ id: 'reader', requires: ['ovo.background-task'] }, (ctx) => {
      (ctx as unknown as PluginContext).get('ovo.background-task');
    });
    await expect(compose([{ id: 'reader' }], [reader])).rejects.toThrow('read it with ctx.all()');
  });

  it('never gates on optional keys, but starts a present optional provider first', async () => {
    const seen: unknown[] = [];
    const consumer = v2Plugin({ id: 'consumer', optional: ['ovo.clock'] }, (ctx) => {
      seen.push((ctx as unknown as PluginContext).maybe('ovo.clock'));
    });
    const alone = await compose([{ id: 'consumer' }], [consumer]);
    const clock = v1Plugin(
      'clock',
      ['ovo.clock'],
      [],
      (ctx) => void ctx.provide('ovo.clock', 'tick'),
    );
    const both = await compose([{ id: 'consumer' }, { id: 'clock' }], [consumer, clock]);
    expect(seen).toEqual([undefined, 'tick']);
    await Promise.all([alone.dispose(), both.dispose()]);
  });

  it('does not turn an optional back-edge into a cycle', () => {
    const a = v2Plugin({ id: 'a', provides: ['a'], optional: ['b'] });
    const b = v1Plugin('b', ['b'], ['a']);
    expect(resolveGraph([{ id: 'a' }, { id: 'b' }], [a, b]).map((p) => p.manifest.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('checks declared majors on both sides', () => {
    const provider = v2Plugin({ id: 'stt', provides: ['ovo.stt@2'] });
    const legacy = v2Plugin({ id: 'legacy', requires: ['ovo.stt@1'] });
    expect(() => resolveGraph([{ id: 'stt' }, { id: 'legacy' }], [provider, legacy])).toThrow(
      'Capability major mismatch',
    );
    const current = v2Plugin({ id: 'current', requires: ['ovo.stt@2'] });
    const unversioned = v1Plugin('unversioned', [], ['ovo.stt']);
    expect(
      resolveGraph(
        [{ id: 'stt' }, { id: 'current' }, { id: 'unversioned' }],
        [provider, current, unversioned],
      ),
    ).toHaveLength(3);
  });
});
