import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { compileConfigSchema, runtimeAjv } from '@winsendotai/ovo-runtime';
import { compose, definePluginV2, jsonSchemaFor } from '../src/index.ts';

const Config = z
  .object({
    endpoint: z.url().default('https://api.example.test/v1'),
    mode: z.enum(['fast', 'accurate']).default('fast'),
    retries: z.number().int().min(0).max(5).default(2),
    labels: z.array(z.string()).default([]),
    region: z.string().optional(),
  })
  .strict();

describe('definePluginV2 (§3.2)', () => {
  it('derives an input-view draft-07 schema the strict runtime Ajv compiles', () => {
    const schema = jsonSchemaFor(Config);
    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toBeUndefined();
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        endpoint: { type: 'string', format: 'uri', default: 'https://api.example.test/v1' },
        mode: { type: 'string', enum: ['fast', 'accurate'], default: 'fast' },
      },
    });
    expect(runtimeAjv.opts.strict).toBe(true);
    const check = compileConfigSchema(schema);
    expect(check({})).toBe(true);
    expect(check({ mode: 'slow' })).toBe(false);
    // The default output view would mark every defaulted field required, and an empty config would fail.
    const output = z.toJSONSchema(Config, { target: 'draft-7' }) as { required?: string[] };
    expect(output.required).toEqual(
      expect.arrayContaining(['endpoint', 'mode', 'retries', 'labels']),
    );
  });

  it('gives an empty row config its defaults and parses it before apply', async () => {
    const received: unknown[] = [];
    const plugin = definePluginV2(
      {
        id: '@acme/ovo-example-v2',
        version: '1.0.0',
        scope: 'session',
        kind: 'infra',
        provides: ['example.v2'],
        config: Config,
      },
      (ctx, config) => {
        expectTypeOf(config.mode).toEqualTypeOf<'fast' | 'accurate'>();
        expectTypeOf(config.retries).toEqualTypeOf<number>();
        received.push(config);
        ctx.provide('example.v2', config);
      },
    );
    expect(plugin.manifest).toMatchObject({ contractVersion: 2, kind: 'infra' });
    const composition = await compose([{ id: '@acme/ovo-example-v2' }], [plugin]);
    expect(received).toEqual([
      { endpoint: 'https://api.example.test/v1', mode: 'fast', retries: 2, labels: [] },
    ]);
    await composition.dispose();
    await expect(
      compose([{ id: '@acme/ovo-example-v2', config: { retries: 'many' } }], [plugin]),
    ).rejects.toThrow('Invalid config');
  });

  it('derives bindingSchema the same way and types the context from the manifest', () => {
    const plugin = definePluginV2(
      {
        id: '@acme/ovo-carrier-v2',
        version: '1.0.0',
        scope: 'process',
        kind: 'infra',
        provides: ['ovo.background-task'],
        requires: ['ovo.clock'],
        config: z.object({}).strict(),
        binding: z.object({
          streamEndTerminatesCall: z.literal(true),
          region: z.string().default('in'),
        }),
      },
      (ctx) => {
        expectTypeOf(ctx.get('ovo.clock').now).returns.toEqualTypeOf<number>();
        ctx.provide('ovo.background-task', { id: 't', intervalMs: 1, tick: async () => undefined });
      },
    );
    const manifest = plugin.manifest as { bindingSchema?: Record<string, unknown> };
    expect(manifest.bindingSchema).toMatchObject({
      type: 'object',
      required: ['streamEndTerminatesCall'],
      properties: { streamEndTerminatesCall: { const: true } },
    });
  });

  it('fails at definition time when the strict runtime Ajv cannot compile the schema', () => {
    expect(() =>
      definePluginV2(
        {
          id: 'union',
          version: '1.0.0',
          scope: 'session',
          kind: 'infra',
          provides: [],
          config: z.object({ value: z.union([z.string(), z.number()]) }),
        },
        () => undefined,
      ),
    ).toThrow('strict mode');
  });
});
