import Ajv from 'ajv';
import { Context, type Plugin } from '@deepseek-ai/cordis';
import { Manifest, type Manifest as PluginManifest } from '@winsendotai/ovo-contracts';
import { createScope, type Scope } from './upstream/scope.ts';
import { composeEntries, type EntryOptions, type PatchOptions } from './upstream/composition.ts';
import { startHostHalf } from './upstream/lifecycle.ts';

export { Context, createScope, composeEntries };
export type { EntryOptions, PatchOptions };
export interface PluginDefinition {
  manifest: PluginManifest;
  apply: (ctx: Context, config: Record<string, unknown>) => void | Promise<void>;
}
export function definePlugin(
  manifest: PluginManifest,
  apply: PluginDefinition['apply'],
): PluginDefinition {
  return { manifest: Manifest.parse(manifest), apply };
}
export interface PluginRow {
  id: string;
  config?: Record<string, unknown>;
}
/** Validate the full graph before any plugin may allocate resources. */
export function resolveGraph(
  rows: PluginRow[],
  catalog: readonly PluginDefinition[],
): PluginDefinition[] {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('Duplicate plugin row');
  const selected = rows.map((row) => {
    const p = catalog.find((p) => p.manifest.id === row.id);
    if (!p) throw new Error(`Unknown approved plugin: ${row.id}`);
    return p;
  });
  const providers = new Map<string, PluginDefinition>();
  for (const p of selected)
    for (const service of p.manifest.provides) {
      if (providers.has(service)) throw new Error(`Ambiguous service: ${service}`);
      providers.set(service, p);
    }
  const ordered: PluginDefinition[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(p: PluginDefinition) {
    const id = p.manifest.id;
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
    visiting.add(id);
    for (const key of p.manifest.requires) {
      const dependency = providers.get(key);
      if (!dependency) throw new Error(`Missing service ${key} for ${id}`);
      visit(dependency);
    }
    visiting.delete(id);
    done.add(id);
    ordered.push(p);
  }
  for (const p of selected) visit(p);
  return ordered;
}
export interface Composition {
  ctx: Context;
  lock: readonly { id: string; version: string }[];
  dispose(): Promise<void>;
}
/** A release owns a DeepSeek scope. Runtime services and effects are Cordis-owned. */
export async function compose(
  rows: PluginRow[],
  catalog: readonly PluginDefinition[],
): Promise<Composition> {
  // DeepSeek's actual profile patch algorithm produces the pinned release rows.
  const entries = composeEntries(
    [[{ insert: rows.map((row) => ({ id: row.id, name: row.id, config: row.config ?? {} })) }]],
    (message) => {
      throw new Error(message);
    },
  );
  const snapshot: PluginRow[] = entries.map((entry) => ({
    id: entry.id!,
    config: entry.config as Record<string, unknown>,
  }));
  const ordered = resolveGraph(snapshot, catalog);
  const validator = new Ajv({ allErrors: true, strict: true });
  for (const definition of ordered) {
    const config = snapshot.find((row) => row.id === definition.manifest.id)?.config ?? {};
    const check = validator.compile(definition.manifest.configSchema);
    if (!check(config))
      throw new Error(
        `Invalid config for ${definition.manifest.id}: ${validator.errorsText(check.errors)}`,
      );
  }
  const ctx = new Context();
  let scope: Scope | undefined;
  try {
    await ctx.plugin((inner: Context) => {
      scope = createScope(inner, {});
    });
    for (const definition of ordered) {
      const plugin: Plugin = {
        name: definition.manifest.id,
        inject: definition.manifest.requires,
        apply: definition.apply,
      };
      const config = snapshot.find((r) => r.id === definition.manifest.id)?.config ?? {};
      await startHostHalf(scope!.ctx.fiber, plugin, config);
      for (const service of definition.manifest.provides)
        if (scope!.ctx.get(service) === undefined)
          throw new Error(`Plugin did not provide ${service}`);
    }
    let disposing: Promise<void> | undefined;
    return {
      ctx: scope!.ctx,
      lock: Object.freeze(
        ordered.map((p) => Object.freeze({ id: p.manifest.id, version: p.manifest.version })),
      ),
      dispose: () =>
        (disposing ??= (async () => {
          await scope!.dispose();
          await ctx.fiber.dispose();
        })()),
    };
  } catch (error) {
    await scope?.dispose();
    await ctx.fiber.dispose();
    throw error;
  }
}
