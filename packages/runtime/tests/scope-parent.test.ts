import { describe, expect, it } from 'vitest';
import { compose, type PluginContext } from '../src/index.ts';
import { v1Plugin, v2Plugin } from './support.ts';

/** The process graph: a process-scope operations service, a net port and a session-only key. */
async function processGraph() {
  const operations = { name: 'operations' };
  const host = v1Plugin(
    'host',
    ['ovo.operations', 'ovo.net', 'ovo.media.duplex'],
    [],
    (ctx) => {
      ctx.provide('ovo.operations', operations);
      ctx.provide('ovo.net', { fetch: async () => new Response(''), websocket: () => undefined });
      ctx.provide('ovo.media.duplex', { sessionless: true });
    },
    { scope: 'process' },
  );
  return { operations, parent: await compose([{ id: 'host' }], [host], { scope: 'process' }) };
}

const sttProvider = (label: string) =>
  v1Plugin('stt', ['ovo.stt'], [], (ctx) => void ctx.provide('ovo.stt', { label }));

describe('scope and parent composition (§3.5)', () => {
  it('composes concurrent sessions that each provide ovo.stt under one parent', async () => {
    const { operations, parent } = await processGraph();
    const seen: Record<string, unknown>[] = [];
    const consumer = v2Plugin(
      { id: 'consumer', requires: ['ovo.stt', 'ovo.operations'] },
      (ctx) => {
        const guarded = ctx as unknown as PluginContext;
        seen.push({ stt: guarded.get('ovo.stt'), operations: guarded.get('ovo.operations') });
      },
    );
    const rows = [{ id: 'stt' }, { id: 'consumer' }];
    const [a, b] = await Promise.all([
      compose(rows, [sttProvider('a'), consumer], { scope: 'session', parent }),
      compose(rows, [sttProvider('b'), consumer], { scope: 'session', parent }),
    ]);
    expect(seen).toEqual(
      expect.arrayContaining([
        { stt: { label: 'a' }, operations },
        { stt: { label: 'b' }, operations },
      ]),
    );
    // Separate Cordis roots: never a Cordis child of the process composition.
    expect(a.ctx.root).not.toBe(parent.ctx.root);
    expect(a.ctx.root).not.toBe(b.ctx.root);
    expect(a.ctx.get('ovo.stt')).toEqual({ label: 'a' });
    expect(b.ctx.get('ovo.stt')).toEqual({ label: 'b' });
    expect(parent.ctx.get('ovo.stt')).toBeUndefined();
    expect(a.keys.has('ovo.operations')).toBe(true);
    expect(a.get('ovo.operations')).toBe(operations);
    await Promise.all([a.dispose(), b.dispose()]);
    expect(parent.ctx.get('ovo.operations')).toBe(operations);
    await parent.dispose();
  });

  it('counts parent keys as satisfied, but never session-scoped ones', async () => {
    const { parent } = await processGraph();
    const needsOps = v1Plugin('needs-ops', [], ['ovo.operations']);
    await expect(compose([{ id: 'needs-ops' }], [needsOps])).rejects.toThrow(
      'Missing service ovo.operations for needs-ops',
    );
    await (await compose([{ id: 'needs-ops' }], [needsOps], { parent })).dispose();
    const needsMedia = v1Plugin('needs-media', [], ['ovo.media.duplex']);
    await expect(compose([{ id: 'needs-media' }], [needsMedia], { parent })).rejects.toThrow(
      'Missing service ovo.media.duplex',
    );
    await parent.dispose();
  });

  it('serves only declared parent keys through the facade', async () => {
    const { parent } = await processGraph();
    let read: unknown = 'unset';
    const snoop = v1Plugin('snoop', [], [], (ctx) => {
      read = ctx.get('ovo.operations');
    });
    const composition = await compose([{ id: 'snoop' }], [snoop], { parent, enforcement: 'warn' });
    expect(read).toBeUndefined();
    expect(composition.violations).toMatchObject([
      { kind: 'read-undeclared', key: 'ovo.operations' },
    ]);
    await composition.dispose();
    await parent.dispose();
  });

  it('rejects a scope mismatch only when a scope is given', async () => {
    const processPlugin = v1Plugin('process-only', ['x'], [], (ctx) => void ctx.provide('x', 1), {
      scope: 'process',
    });
    await expect(
      compose([{ id: 'process-only' }], [processPlugin], { scope: 'session' }),
    ).rejects.toThrow('Plugin process-only is process-scoped; this composition is session-scoped');
    const unscoped = await compose([{ id: 'process-only' }], [processPlugin]);
    expect(unscoped.scope).toBeUndefined();
    await unscoped.dispose();
  });
});
