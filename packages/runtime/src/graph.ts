import {
  capabilitySpec,
  normalizeManifest,
  parseCapabilityEntry,
  type Manifest,
  type ManifestV2,
} from '@winsendotai/ovo-contracts';
import type { PluginDefinition, PluginRow } from './define.ts';

export interface ParsedEntry {
  key: string;
  major?: number;
}

/** A manifest's declared keys, with `@major` suffixes parsed (v1 manifests are upcast first). */
export interface ManifestKeys {
  manifest: ManifestV2;
  provides: ParsedEntry[];
  requires: ParsedEntry[];
  optional: ParsedEntry[];
}

const keyCache = new WeakMap<Manifest, ManifestKeys>();

export function manifestKeys(manifest: Manifest): ManifestKeys {
  let keys = keyCache.get(manifest);
  if (!keys) {
    const normalized = normalizeManifest(manifest);
    keys = {
      manifest: normalized,
      provides: normalized.provides.map(parseCapabilityEntry),
      requires: normalized.requires.map(parseCapabilityEntry),
      optional: normalized.optional.map(parseCapabilityEntry),
    };
    keyCache.set(manifest, keys);
  }
  return keys;
}

/** A provider of a cardinality-'many' key registers under `${key}:${qualifier}`. */
export function qualifierOf(manifest: Manifest): string {
  return (manifest.contractVersion === 2 && manifest.provider) || manifest.id;
}

export const isMany = (key: string) => capabilitySpec(key).cardinality === 'many';

export interface GraphOptions {
  /** Keys a parent composition (or the host) satisfies. They count as present (§3.5). */
  parentKeys?: Iterable<string>;
}

interface Provider {
  definition: PluginDefinition;
  major?: number;
}

/** Validate the full graph before any plugin may allocate resources. */
export function resolveGraph(
  rows: PluginRow[],
  catalog: readonly PluginDefinition[],
  opts: GraphOptions = {},
): PluginDefinition[] {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('Duplicate plugin row');
  const selected = rows.map((row) => {
    const p = catalog.find((p) => p.manifest.id === row.id);
    if (!p) throw new Error(`Unknown approved plugin: ${row.id}`);
    return p;
  });
  const parentKeys = new Set(opts.parentKeys ?? []);
  const one = new Map<string, Provider>();
  const many = new Map<string, Map<string, Provider>>();
  for (const definition of selected)
    for (const entry of manifestKeys(definition.manifest).provides) {
      const provider = { definition, major: entry.major };
      if (isMany(entry.key)) {
        const byQualifier = many.get(entry.key) ?? new Map<string, Provider>();
        const qualifier = qualifierOf(definition.manifest);
        if (byQualifier.has(qualifier))
          throw new Error(`Ambiguous service: ${entry.key}:${qualifier}`);
        many.set(entry.key, byQualifier.set(qualifier, provider));
      } else {
        if (one.has(entry.key)) throw new Error(`Ambiguous service: ${entry.key}`);
        one.set(entry.key, provider);
      }
    }
  const checkMajor = (id: string, entry: ParsedEntry, provider: Provider) => {
    if (entry.major !== undefined && provider.major !== undefined && entry.major !== provider.major)
      throw new Error(
        `Capability major mismatch: ${id} requires ${entry.key}@${entry.major}, ` +
          `${provider.definition.manifest.id} provides @${provider.major}`,
      );
  };
  const providersOf = (key: string): Provider[] =>
    isMany(key)
      ? [...(many.get(key)?.values() ?? [])]
      : [one.get(key)].filter((item): item is Provider => !!item);
  const reachesVisiting = (p: PluginDefinition, seen: Set<string>): boolean => {
    const id = p.manifest.id;
    if (visiting.has(id)) return true;
    if (done.has(id) || seen.has(id)) return false;
    seen.add(id);
    const keys = manifestKeys(p.manifest);
    const optional = new Set(keys.optional.map((entry) => entry.key));
    return keys.requires.some(
      (entry) =>
        !optional.has(entry.key) &&
        providersOf(entry.key).some((provider) => reachesVisiting(provider.definition, seen)),
    );
  };
  const ordered: PluginDefinition[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(p: PluginDefinition) {
    const id = p.manifest.id;
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
    visiting.add(id);
    const keys = manifestKeys(p.manifest);
    const optional = new Set(keys.optional.map((entry) => entry.key));
    for (const entry of keys.requires) {
      if (optional.has(entry.key)) continue;
      if (isMany(entry.key)) {
        for (const provider of many.get(entry.key)?.values() ?? []) {
          checkMajor(id, entry, provider);
          visit(provider.definition);
        }
        continue;
      }
      const dependency = one.get(entry.key);
      if (dependency) {
        checkMajor(id, entry, dependency);
        visit(dependency.definition);
      } else if (!parentKeys.has(entry.key))
        throw new Error(`Missing service ${entry.key} for ${id}`);
    }
    // Optional keys never gate; a present provider only starts first when that forms no cycle.
    for (const entry of keys.optional)
      for (const provider of providersOf(entry.key))
        if (!reachesVisiting(provider.definition, new Set())) visit(provider.definition);
    visiting.delete(id);
    done.add(id);
    ordered.push(p);
  }
  for (const p of selected) visit(p);
  return ordered;
}
