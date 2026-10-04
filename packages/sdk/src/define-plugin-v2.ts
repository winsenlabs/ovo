import { z } from 'zod';
import {
  compileConfigSchema,
  definePlugin,
  type ManifestV2Literal,
  type PluginContext,
  type PluginDefinition,
  type ProvOf,
  type ReqOf,
} from '@winsendotai/ovo-runtime';

/**
 * Draft-07 JSON Schema for a zod schema's INPUT: fields with defaults stay optional, so an empty row
 * config validates (the default 'output' view would mark every defaulted field required).
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  }) as Record<string, unknown>;
  return json;
}

/** A v2 manifest without `configSchema`/`bindingSchema`; those come from zod. */
export type PluginSpecV2 = Omit<
  ManifestV2Literal,
  'configSchema' | 'bindingSchema' | 'contractVersion'
> & {
  contractVersion?: 2;
  config: z.ZodType;
  binding?: z.ZodType;
};

/**
 * Define a v2 plugin from zod schemas (§3.2). `configSchema` and `bindingSchema` are derived with
 * `io: 'input'`; the runtime's strict Ajv must compile them, and `apply` receives `config.parse(row)`.
 */
export function definePluginV2<const S extends PluginSpecV2>(
  spec: S,
  apply: (
    ctx: PluginContext<ReqOf<S>, ProvOf<S>>,
    config: z.output<S['config']>,
  ) => void | Promise<void>,
): PluginDefinition {
  const { config, binding, ...manifest } = spec;
  const configSchema = jsonSchemaFor(config);
  compileConfigSchema(configSchema);
  const bindingSchema = binding ? jsonSchemaFor(binding) : undefined;
  return definePlugin(
    {
      ...(manifest as Omit<
        ManifestV2Literal,
        'configSchema' | 'bindingSchema' | 'contractVersion'
      >),
      contractVersion: 2,
      configSchema,
      ...(bindingSchema ? { bindingSchema } : {}),
    },
    (ctx, row) =>
      apply(
        ctx as unknown as PluginContext<ReqOf<S>, ProvOf<S>>,
        config.parse(row) as z.output<S['config']>,
      ),
  );
}
