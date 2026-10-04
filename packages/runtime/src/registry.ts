import Ajv, { type ValidateFunction } from 'ajv';
import type { PluginKind } from '@winsendotai/ovo-contracts';
import { ANNOTATION_FORMATS } from './config-guard.ts';
import type { PluginDefinition } from './define.ts';
import { manifestKeys } from './graph.ts';
import { unavailableReason } from './kind-rules.ts';

/** Kinds whose v2 selections resolve exact-or-same-major (§4.2). Companions follow their engine. */
export const PIN_COMPATIBLE_KINDS: readonly PluginKind[] = [
  'engine',
  'stt',
  'tts',
  'llm',
  'vad',
  'turn-detector',
  'text-filter',
  'carrier',
];

export type PluginPinErrorCode =
  'plugin_not_installed' | 'plugin_version_not_installed' | 'plugin_unavailable';

export class PluginPinError extends Error {
  constructor(
    readonly code: PluginPinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginPinError';
  }
}

export interface UnavailablePlugin {
  id: string;
  version: string;
  reason: string;
}

/** JSON-safe public view of one installed plugin. No functions, never a secret value. */
export type ProjectedPlugin = Record<string, unknown> & {
  id: string;
  version: string;
  kind: PluginKind;
  available: boolean;
  unavailableReason?: string;
};

const semver = (version: string) => version.split('.').map(Number) as [number, number, number];
const newestFirst = (a: PluginDefinition, b: PluginDefinition) => {
  const [x, y] = [semver(a.manifest.version), semver(b.manifest.version)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

/** The installed plugin catalog as the host sees it (§3.9). */
export class PluginRegistry {
  readonly #catalog: readonly PluginDefinition[];
  readonly #unavailable = new Map<PluginDefinition, string>();
  readonly #bindingAjv = new Ajv({
    strict: false,
    allErrors: true,
    formats: { ...ANNOTATION_FORMATS },
  });
  readonly #bindingChecks = new WeakMap<object, ValidateFunction>();

  constructor(catalog: readonly PluginDefinition[]) {
    this.#catalog = [...catalog].sort(newestFirst);
    for (const definition of this.#catalog) {
      const reason = unavailableReason(definition.manifest);
      if (reason) this.#unavailable.set(definition, reason);
    }
  }

  /** Installed plugins, newest version first, optionally of one kind (v1 manifests are 'infra'). */
  list(kind?: PluginKind): PluginDefinition[] {
    return this.#catalog.filter((item) => !kind || this.#kind(item) === kind);
  }

  /** Exactly one plugin of `kind` whose provider or id is `providerOrId`, or throws. */
  resolve(kind: PluginKind, providerOrId: string): PluginDefinition {
    const matches = this.list(kind).filter((item) => {
      const manifest = manifestKeys(item.manifest).manifest;
      return manifest.provider === providerOrId || manifest.id === providerOrId;
    });
    const ids = new Set(matches.map((item) => item.manifest.id));
    if (ids.size !== 1)
      throw new Error(
        ids.size
          ? `Multiple installed ${kind} plugins match ${providerOrId}: ${[...ids].join(', ')}`
          : `No installed ${kind} plugin matches ${providerOrId}`,
      );
    return matches[0]!;
  }

  /** The exact version, or the newest installed version when none is given. */
  get(id: string, version?: string): PluginDefinition | undefined {
    return this.#catalog.find(
      (item) => item.manifest.id === id && (!version || item.manifest.version === version),
    );
  }

  /**
   * Exact `id@version`, otherwise the newest same-id, same-major version for pin-compatible kinds and
   * engine companions. A different major, or a missing id, throws a `PluginPinError`.
   */
  resolvePin(id: string, version: string): { definition: PluginDefinition; exact: boolean } {
    const exact = this.get(id, version);
    if (exact) return { definition: this.#available(exact), exact: true };
    const candidates = this.#catalog.filter((item) => item.manifest.id === id);
    if (!candidates.length)
      throw new PluginPinError('plugin_not_installed', `${id} is not installed`);
    const major = semver(version)[0];
    const compatible = candidates.find(
      (item) =>
        semver(item.manifest.version)[0] === major &&
        (PIN_COMPATIBLE_KINDS.includes(this.#kind(item)) || this.#isCompanion(id)),
    );
    if (!compatible)
      throw new PluginPinError(
        'plugin_version_not_installed',
        `${id}@${version} is not installed (installed: ${candidates.map((item) => item.manifest.version).join(', ')})`,
      );
    return { definition: this.#available(compatible), exact: false };
  }

  /**
   * Ajv (strict: false) against the plugin's `bindingSchema`; no schema accepts any object. Formats
   * are annotations here too; zod-derived binding schemas are enforced by the plugin at apply.
   */
  validateBinding(pluginId: string, config: unknown): { ok: true } | { ok: false; errors: string } {
    const definition = this.get(pluginId);
    if (!definition) return { ok: false, errors: `${pluginId} is not installed` };
    const schema = manifestKeys(definition.manifest).manifest.bindingSchema;
    if (!schema) return { ok: true };
    let check = this.#bindingChecks.get(schema);
    if (!check) this.#bindingChecks.set(schema, (check = this.#bindingAjv.compile(schema)));
    return check(config)
      ? { ok: true }
      : { ok: false, errors: this.#bindingAjv.errorsText(check.errors) };
  }

  /** A JSON-safe public view (manifest data only; functions and undefined values are dropped). */
  project(): ProjectedPlugin[] {
    return this.#catalog.map((definition) => {
      const normalized = manifestKeys(definition.manifest).manifest;
      const reason = this.#unavailable.get(definition);
      return {
        ...(JSON.parse(JSON.stringify(definition.manifest)) as Record<string, unknown>),
        id: normalized.id,
        version: normalized.version,
        kind: normalized.kind,
        optional: [...normalized.optional],
        available: !reason,
        ...(reason ? { unavailableReason: reason } : {}),
      };
    });
  }

  /** Plugins that failed runtime checks (for example glibc), with the reason. */
  unavailable(): UnavailablePlugin[] {
    return [...this.#unavailable].map(([definition, reason]) => ({
      id: definition.manifest.id,
      version: definition.manifest.version,
      reason,
    }));
  }

  #kind(definition: PluginDefinition): PluginKind {
    return manifestKeys(definition.manifest).manifest.kind;
  }

  #isCompanion(id: string): boolean {
    return this.#catalog.some((item) =>
      Object.values(manifestKeys(item.manifest).manifest.companions ?? {}).includes(id),
    );
  }

  #available(definition: PluginDefinition): PluginDefinition {
    const reason = this.#unavailable.get(definition);
    if (reason) throw new PluginPinError('plugin_unavailable', reason);
    return definition;
  }
}
