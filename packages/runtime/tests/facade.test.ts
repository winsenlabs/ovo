import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Clock, NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import {
  Context,
  PluginViolationError,
  compose,
  definePlugin,
  type PluginContext,
} from '../src/index.ts';
import { engineManifest, v1Plugin, v2Plugin } from './support.ts';

const socket = { readyState: 1 } as unknown as WebSocketLike;
const fakeNet = () => ({
  fetch: vi.fn(async (_url: string) => new Response('ok')),
  websocket: vi.fn((_url: string) => socket),
});

describe('guarded plugin context (§3.3)', () => {
  it('records undeclared reads and provides in warn mode, and still serves them', async () => {
    const provider = v1Plugin('provider', ['a', 'b'], [], (ctx) => {
      ctx.provide('a', 1);
      ctx.provide('b', 2);
    });
    let read: unknown;
    const consumer = v1Plugin('consumer', ['own'], ['a'], (ctx) => {
      read = ctx.get('b');
      ctx.provide('own', 'mine');
      ctx.provide('extra', 3);
    });
    const composition = await compose(
      [{ id: 'provider' }, { id: 'consumer' }],
      [provider, consumer],
      {
        enforcement: 'warn',
      },
    );
    expect(read).toBe(2);
    expect(composition.violations.map((v) => [v.pluginId, v.kind, v.key, v.mode])).toEqual([
      ['consumer', 'read-undeclared', 'b', 'warn'],
      ['consumer', 'provide-undeclared', 'extra', 'warn'],
    ]);
    expect(composition.ctx.get('extra')).toBe(3);
    await composition.dispose();
  });

  it('throws undeclared reads and provides in enforce mode', async () => {
    const provider = v1Plugin('provider', ['a', 'b'], [], (ctx) => {
      ctx.provide('a', 1);
      ctx.provide('b', 2);
    });
    const reader = v1Plugin('reader', [], ['a'], (ctx) => void ctx.get('b'));
    await expect(
      compose([{ id: 'provider' }, { id: 'reader' }], [provider, reader], {
        enforcement: 'enforce',
      }),
    ).rejects.toThrow('read-undeclared: reader read b');
    const writer = v2Plugin({ id: 'writer', provides: ['own'] }, (ctx) => {
      ctx.provide('own', 1);
      ctx.provide('other', 2);
    });
    // v2 manifests always enforce, whatever the option says.
    await expect(compose([{ id: 'writer' }], [writer], { enforcement: 'warn' })).rejects.toThrow(
      PluginViolationError,
    );
  });

  it('serves declared reads, own provides, maybe, all and reflect.get without violations', async () => {
    const provider = v1Plugin('provider', ['a'], [], (ctx) => void ctx.provide('a', 'A'));
    const seen: unknown[] = [];
    const consumer = v2Plugin(
      { id: 'consumer', provides: ['own'], requires: ['a'], optional: ['maybe-absent'] },
      (ctx) => {
        const guarded = ctx as unknown as PluginContext;
        guarded.provide('own', 'O');
        seen.push(
          guarded.get('a'),
          guarded.get('own'),
          guarded.maybe('maybe-absent'),
          [...guarded.all('a')],
          ctx.reflect.get('a'),
        );
        expect(() => guarded.get('maybe-absent')).toThrow('Missing capability maybe-absent');
      },
    );
    const composition = await compose(
      [{ id: 'provider' }, { id: 'consumer' }],
      [provider, consumer],
    );
    expect(seen).toEqual(['A', 'O', undefined, [['a', 'A']], 'A']);
    expect(composition.violations).toEqual([]);
    await composition.dispose();
  });

  it('still serves the Cordis members a plugin legitimately uses', async () => {
    const cleaned: string[] = [];
    const plugin = v1Plugin('plain', ['plain'], [], (ctx) => {
      ctx.provide('plain', {});
      ctx.effect(() => () => void cleaned.push('effect'));
      ctx.fiber.effect(() => () => void cleaned.push('fiber'), 'fiber effect');
    });
    const composition = await compose([{ id: 'plain' }], [plugin]);
    expect(composition.violations).toEqual([]);
    await composition.dispose();
    expect(cleaned.sort()).toEqual(['effect', 'fiber']);
  });

  // Without this the manifest graph is advisory: ctx.plugin/ctx.root/ctx.inject all hand back an
  // unguarded context, from which any service can be read or provided undeclared.
  it('blocks the raw Cordis members that would bypass the manifest', async () => {
    const reached: Record<string, unknown> = {};
    const plugin = v1Plugin('escapee', ['own'], [], (ctx) => {
      const raw = ctx as unknown as Record<string, unknown>;
      for (const member of ['plugin', 'inject', 'root', 'scope', 'extend', 'on'])
        reached[member] = raw[member];
      reached['fiberDispose'] = (raw['fiber'] as Record<string, unknown> | undefined)?.['dispose'];
      ctx.provide('own', 1);
    });
    const composition = await compose([{ id: 'escapee' }], [plugin], { enforcement: 'warn' });
    expect(Object.values(reached).every((value) => value === undefined)).toBe(true);
    expect(
      composition.violations.filter((v) => v.kind === 'context-escape').map((v) => v.key),
    ).toEqual(['plugin', 'inject', 'root', 'scope', 'extend', 'on']);
    await composition.dispose();
  });

  it('throws on a context escape in enforce mode', async () => {
    const plugin = v1Plugin('escapee', ['own'], [], (ctx) => {
      void (ctx as unknown as Record<string, unknown>)['plugin'];
      ctx.provide('own', 1);
    });
    await expect(
      compose([{ id: 'escapee' }], [plugin], { enforcement: 'enforce' }),
    ).rejects.toThrow(PluginViolationError);
  });

  it('always throws egress-denied, even in warn mode', async () => {
    const net = fakeNet();
    let captured: PluginContext | undefined;
    const legacy = v1Plugin('legacy', [], [], (ctx) => {
      captured = ctx as unknown as PluginContext;
    });
    const composition = await compose([{ id: 'legacy' }], [legacy], { enforcement: 'warn', net });
    await expect(captured!.net.fetch('https://api.example.test/')).rejects.toThrow('egress-denied');
    expect(composition.violations.map((v) => [v.kind, v.key, v.mode])).toEqual([
      ['egress-denied', 'api.example.test', 'warn'],
    ]);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('lets declared egress hosts through, https for fetch and wss for websockets only', async () => {
    const net: NetPort = fakeNet();
    let captured: PluginContext | undefined;
    const plugin = v2Plugin(
      {
        id: 'egress',
        runtime: { egressHosts: ['api.example.test', '*.cdn.example.test'], modelLicences: [] },
      },
      (ctx) => {
        captured = ctx as unknown as PluginContext;
      },
    );
    await compose([{ id: 'egress' }], [plugin], { net });
    const guarded = captured!.net;
    await expect(guarded.fetch('https://api.example.test/v1')).resolves.toBeInstanceOf(Response);
    await expect(guarded.fetch('https://eu.cdn.example.test/a')).resolves.toBeInstanceOf(Response);
    expect(guarded.websocket('wss://API.example.test/listen')).toBe(socket);
    await expect(guarded.fetch('http://api.example.test/v1')).rejects.toThrow('egress-denied');
    await expect(guarded.fetch('https://cdn.example.test/')).rejects.toThrow('egress-denied');
    await expect(guarded.fetch('not a url')).rejects.toThrow('egress-denied');
    expect(() => guarded.websocket('https://api.example.test/listen')).toThrow('egress-denied');
    expect(net.fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the parent ovo.net when the composition gives none', async () => {
    const net = fakeNet();
    const parent = await compose(
      [{ id: 'net' }],
      [
        v1Plugin('net', ['ovo.net'], [], (ctx) => void ctx.provide('ovo.net', net), {
          scope: 'process',
        }),
      ],
    );
    let captured: PluginContext | undefined;
    const child = v2Plugin(
      { id: 'child', runtime: { egressHosts: ['a.test'], modelLicences: [] } },
      (ctx) => {
        captured = ctx as unknown as PluginContext;
      },
    );
    await compose([{ id: 'child' }], [child], { parent });
    await captured!.net.fetch('https://a.test/');
    expect(net.fetch).toHaveBeenCalledWith('https://a.test/', undefined);
  });

  it('always throws engine-tool-access, at compose time and at run time', async () => {
    const declared = definePlugin(
      engineManifest({ id: 'engine', requires: ['ovo.execution'] }) as never,
      () => {},
    );
    await expect(compose([{ id: 'engine' }], [declared])).rejects.toThrow('engine-tool-access');
    const tools = v1Plugin(
      'tools',
      ['ovo.execution'],
      [],
      (ctx) => void ctx.provide('ovo.execution', {}),
    );
    const sneaky = definePlugin(engineManifest({ id: 'sneaky' }) as never, (ctx) => {
      (ctx as unknown as PluginContext).maybe('ovo.execution');
    });
    const error = await compose([{ id: 'tools' }, { id: 'sneaky' }], [tools, sneaky]).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(PluginViolationError);
    expect((error as PluginViolationError).violation).toMatchObject({
      kind: 'engine-tool-access',
      key: 'ovo.execution',
    });
    const connector = definePlugin(engineManifest({ id: 'connector' }) as never, (ctx) => {
      (ctx as unknown as PluginContext).provide('ovo.tool-connector.native', {} as never);
    });
    await expect(compose([{ id: 'connector' }], [connector])).rejects.toThrow('engine-tool-access');
  });

  it('types get and provide from inline and as-const v2 manifests', () => {
    definePlugin(
      {
        id: 'typed',
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'infra',
        provides: ['ovo.clock'],
        requires: ['ovo.stt@2'],
        optional: ['custom.key'],
      },
      (ctx) => {
        expectTypeOf(ctx.get('ovo.stt').start).toBeFunction();
        expectTypeOf(ctx.maybe('custom.key')).toEqualTypeOf<unknown>();
        const clock: Clock = { now: () => 0, setTimeout: () => () => undefined };
        ctx.provide('ovo.clock', clock);
        // @ts-expect-error ovo.vad is not declared
        void (() => ctx.get('ovo.vad'));
        // @ts-expect-error a clock must be a Clock
        void (() => ctx.provide('ovo.clock', 42));
      },
    );
    const manifest = {
      id: 'const',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'process',
      kind: 'infra',
      provides: ['ovo.background-task'],
      requires: [],
    } as const;
    definePlugin(manifest, (ctx) => {
      expectTypeOf(ctx.provide).parameter(0).toEqualTypeOf<'ovo.background-task'>();
    });
  });
});
