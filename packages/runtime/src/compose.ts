import { Context, type Plugin } from '@deepseek-ai/cordis';
import type { NetPort } from '@winsendotai/ovo-contracts';
import { composeEntries } from './upstream/composition.ts';
import { startHostHalf } from './upstream/lifecycle.ts';
import { createScope, type Scope } from './upstream/scope.ts';
import type { PluginDefinition, PluginRow } from './define.ts';
import {
  createViolationLog,
  enforcementMode,
  type EnforcementMode,
  type PluginViolation,
} from './enforcement.ts';
import { createFacade } from './facade.ts';
import { isMany, manifestKeys, qualifierOf } from './graph.ts';
import {
  frozenMap,
  parentReadableKeys,
  qualifiedServices,
  type CompositionScope,
  type ParentView,
} from './scope.ts';
import { validateGraph } from './validate-graph.ts';

export interface ComposeOptions {
  /** Rejects any definition whose manifest scope differs. */
  scope?: CompositionScope;
  /** Declared keys the parent provides are read through the facade; never a Cordis child (§3.5). */
  parent?: ParentView;
  /** Used by `ctx.secret()`. */
  workspaceId?: string;
  /** v1 manifests only (v2 always enforce); defaults to OVO_PLUGIN_ENFORCEMENT, then 'warn'. */
  enforcement?: EnforcementMode;
  /** The host network behind every `ctx.net` (else the parent's or this graph's `ovo.net`). */
  net?: NetPort;
  /** Fixture-kind plugins compose only when true. */
  fixtures?: boolean;
}

export interface Composition extends ParentView {
  /** The raw Cordis context, for host code. Plugins only ever see the guarded facade. */
  ctx: Context;
  lock: readonly { id: string; version: string }[];
  readonly scope?: CompositionScope;
  /** Recorded violations (warn mode) and thrown ones (enforce), in order. */
  readonly violations: readonly PluginViolation[];
  dispose(): Promise<void>;
}

/** A release owns a DeepSeek scope. Every composition is its own Cordis root. */
export async function compose(
  rows: PluginRow[],
  catalog: readonly PluginDefinition[],
  opts: ComposeOptions = {},
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
  const { parent } = opts;
  const parentReadable = parentReadableKeys(parent);
  const { ordered, issues } = validateGraph(snapshot, catalog, {
    scope: opts.scope,
    parentKeys: parentReadable,
    fixtures: opts.fixtures,
  });
  if (issues.length) throw new Error(issues[0]!.message);
  const configOf = (id: string) => snapshot.find((row) => row.id === id)?.config ?? {};
  const local = new Set(
    ordered.flatMap((definition) =>
      manifestKeys(definition.manifest).provides.map((entry) => entry.key),
    ),
  );
  const log = createViolationLog();
  const ctx = new Context();
  let scope: Scope | undefined;
  try {
    await ctx.plugin((inner: Context) => {
      scope = createScope(inner, {});
    });
    for (const definition of ordered) {
      const keys = manifestKeys(definition.manifest);
      const optional = new Set(keys.optional.map((entry) => entry.key));
      const declared = [...keys.requires, ...keys.optional].map((entry) => entry.key);
      const config = configOf(definition.manifest.id);
      const plugin: Plugin = {
        name: definition.manifest.id,
        // Cordis waits only on keys this root provides: never optional, many or parent keys.
        inject: keys.requires
          .map((entry) => entry.key)
          .filter((key) => !optional.has(key) && !isMany(key) && local.has(key)),
        apply: (fiberCtx: Context, fiberConfig: Record<string, unknown>) =>
          definition.apply(
            createFacade(fiberCtx, {
              definition,
              config: fiberConfig,
              mode: enforcementMode(definition.manifest, opts.enforcement),
              log,
              parent,
              parentReadable: new Set(declared.filter((key) => parentReadable.has(key))),
              net: opts.net,
              workspaceId: opts.workspaceId,
            }),
            fiberConfig,
          ),
      };
      await startHostHalf(scope!.ctx.fiber, plugin, config);
      for (const entry of keys.provides) {
        const name = isMany(entry.key)
          ? `${entry.key}:${qualifierOf(definition.manifest)}`
          : entry.key;
        if (scope!.ctx.get(name) === undefined)
          throw new Error(`Plugin did not provide ${entry.key}`);
      }
    }
    const root = scope!;
    const keys = new Set([...local, ...(parent?.keys ?? [])]);
    const get = (key: string): unknown => root.ctx.get(key) ?? parent?.get(key);
    let disposing: Promise<void> | undefined;
    return {
      ctx: root.ctx,
      lock: Object.freeze(
        ordered.map((p) => Object.freeze({ id: p.manifest.id, version: p.manifest.version })),
      ),
      scope: opts.scope,
      keys,
      violations: log.violations,
      get,
      all: (key) => {
        if (isMany(key))
          return frozenMap([...(parent?.all(key) ?? []), ...qualifiedServices(root.ctx, key)]);
        const value = get(key);
        return frozenMap(value === undefined ? [] : [[key, value] as const]);
      },
      dispose: () =>
        (disposing ??= (async () => {
          await root.dispose();
          await ctx.fiber.dispose();
        })()),
    };
  } catch (error) {
    await scope?.dispose();
    await ctx.fiber.dispose();
    throw error;
  }
}
