import { describe, expect, it, vi } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { compose, readPointer, type PluginContext } from '../src/index.ts';
import { v1Plugin, v2Plugin } from './support.ts';

const secretive = (apply: (ctx: PluginContext) => void | Promise<void> = () => undefined) =>
  v2Plugin(
    {
      id: 'secretive',
      secretFields: ['/auth', '/nested/a~1b'],
      configSchema: { type: 'object' },
    },
    (ctx) => apply(ctx as unknown as PluginContext),
  );

describe('secrets (§3.6)', () => {
  it('rejects a plain string at a secret field in every mode', async () => {
    for (const enforcement of ['warn', 'enforce'] as const) {
      const legacy = v1Plugin('legacy', [], [], () => undefined, { secretFields: ['/token'] });
      await expect(
        compose([{ id: 'legacy', config: { token: 'sk-plain' } }], [legacy], { enforcement }),
      ).rejects.toThrow('secret.inline: legacy config /token holds a plain string');
    }
    await expect(
      compose([{ id: 'secretive', config: { nested: { 'a/b': 'plain' } } }], [secretive()]),
    ).rejects.toThrow('secret.inline');
  });

  it('resolves {credentialRef} through the host resolver with the composition workspace', async () => {
    const resolve = vi.fn(
      async (workspaceId: string, credentialId: string) => `${workspaceId}:${credentialId}`,
    );
    const parent = await compose(
      [{ id: 'secrets' }],
      [
        v1Plugin(
          'secrets',
          [Cap.secrets],
          [],
          (ctx) => void ctx.provide(Cap.secrets, { resolve }),
          { scope: 'process' },
        ),
      ],
    );
    const resolved: string[] = [];
    const plugin = secretive(async (ctx) => {
      resolved.push(await ctx.secret('/auth'), await ctx.secret('/nested/a~1b'));
      await expect(ctx.secret('/missing')).rejects.toThrow('holds no {credentialRef}');
    });
    const composition = await compose(
      [
        {
          id: 'secretive',
          config: {
            auth: { credentialRef: { credentialId: 'cred-1' } },
            nested: { 'a/b': { credentialRef: { credentialId: 'cred-2' } } },
          },
        },
      ],
      [plugin],
      { parent, workspaceId: 'workspace-1' },
    );
    expect(resolved).toEqual(['workspace-1:cred-1', 'workspace-1:cred-2']);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(composition.violations).toEqual([]);
    await composition.dispose();
    await parent.dispose();
  });

  it('needs a workspace and a resolver', async () => {
    const errors: string[] = [];
    const plugin = secretive(async (ctx) => {
      await ctx.secret('/auth').catch((error: Error) => errors.push(error.message));
    });
    const config = { auth: { credentialRef: { credentialId: 'cred-1' } } };
    await (await compose([{ id: 'secretive', config }], [plugin])).dispose();
    await (await compose([{ id: 'secretive', config }], [plugin], { workspaceId: 'w' })).dispose();
    expect(errors).toEqual([
      'secretive: ctx.secret needs a workspaceId',
      `secretive: ${Cap.secrets} is not available`,
    ]);
  });

  it('reads RFC 6901 pointers', () => {
    const document = { a: { 'b/c': { '~d': 1 } }, list: [10, 20] };
    expect(readPointer(document, '')).toBe(document);
    expect(readPointer(document, '/a/b~1c/~0d')).toBe(1);
    expect(readPointer(document, '/list/1')).toBe(20);
    expect(readPointer(document, '/a/missing')).toBeUndefined();
    expect(readPointer(document, 'a')).toBeUndefined();
  });
});
