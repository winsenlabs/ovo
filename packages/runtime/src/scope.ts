import type { Context } from '@deepseek-ai/cordis';
import { capabilitySpec } from '@winsendotai/ovo-contracts';
import type { PluginDefinition } from './define.ts';

export type CompositionScope = 'process' | 'session';

/** What a child composition may see of its parent. Every composition is its own Cordis root (§3.5). */
export interface ParentView {
  /** Every key readable through the parent (its own provides and its parent's). */
  readonly keys: ReadonlySet<string>;
  get(key: string): unknown;
  all(key: string): ReadonlyMap<string, unknown>;
}

/** Keys a child may read from `parent`: provided there, with spec scope 'process' or 'either'. */
export function parentReadableKeys(parent: ParentView | undefined): Set<string> {
  const keys = new Set<string>();
  for (const key of parent?.keys ?? []) if (capabilitySpec(key).scope !== 'session') keys.add(key);
  return keys;
}

/** One entry per definition whose manifest scope differs from the composition scope. */
export function scopeErrors(
  definitions: readonly PluginDefinition[],
  scope: CompositionScope | undefined,
): { pluginId: string; message: string }[] {
  if (!scope) return [];
  return definitions
    .filter((definition) => definition.manifest.scope !== scope)
    .map(({ manifest }) => ({
      pluginId: manifest.id,
      message: `Plugin ${manifest.id} is ${manifest.scope}-scoped; this composition is ${scope}-scoped`,
    }));
}

/** A Map whose mutators throw, frozen. */
export function frozenMap<V>(entries: Iterable<readonly [string, V]>): ReadonlyMap<string, V> {
  const map = new Map<string, V>(entries);
  const refuse = () => {
    throw new TypeError('Capability map is read-only');
  };
  Object.defineProperties(map, {
    set: { value: refuse },
    delete: { value: refuse },
    clear: { value: refuse },
  });
  return Object.freeze(map);
}

/** Every `${key}:${qualifier}` service provided in this Cordis root, keyed by qualifier. */
export function qualifiedServices(ctx: Context, key: string): Map<string, unknown> {
  const prefix = `${key}:`;
  const found = new Map<string, unknown>();
  for (const name of Object.keys(ctx.reflect.props)) {
    if (!name.startsWith(prefix)) continue;
    const value = ctx.get(name);
    if (value !== undefined) found.set(name.slice(prefix.length), value);
  }
  return found;
}
