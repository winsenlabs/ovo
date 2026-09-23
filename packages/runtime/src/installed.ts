import type {
  FixtureTemplate,
  NativeToolHandler,
  NetFixtureScript,
  PluginKind,
} from '@winsendotai/ovo-contracts';
import { definePlugin, type PluginDefinition } from './define.ts';
import { manifestKeys } from './graph.ts';
import { unavailableReason } from './kind-rules.ts';
import type { UnavailablePlugin } from './registry.ts';

export interface InstalledNativeHandlerPackage {
  packageName: string;
  packageVersion: string;
  pluginId: string;
  pluginVersion: string;
  handlerIds: readonly string[];
}

export interface InstalledSessionExtensions {
  plugins: PluginDefinition[];
  nativeHandlers: Record<string, NativeToolHandler>;
  /** Present on loader results. Optional only for empty host-side fixture defaults. */
  nativeHandlerPackages?: InstalledNativeHandlerPackage[];
  /** Static protocol fixtures by plugin id (§2.3). Present on loader results. */
  fixtures?: Record<string, NetFixtureScript[]>;
  /** Fixture templates by plugin id (§2.3). Present on loader results. */
  fixtureTemplates?: Record<string, FixtureTemplate>;
  /** Plugins that loaded but cannot run here (for example glibc). Present on loader results. */
  unavailable?: UnavailablePlugin[];
}

interface NativeHandlerModuleExport {
  package: { name: string; version: string };
  plugin: { id: string; version: string };
  handlers: Record<string, NativeToolHandler>;
}

const VERSION = /^\d+\.\d+\.\d+$/;
/** Single-provider session kinds. Filter kinds are many and are identified by plugin id. */
const SESSION_KINDS: readonly PluginKind[] = [
  'engine',
  'stt',
  'tts',
  'llm',
  'vad',
  'turn-detector',
  'voicemail',
];

function parseNames(encoded: string): string[] {
  let names: unknown;
  try {
    names = JSON.parse(encoded);
  } catch {
    throw new Error('OVO_PLUGIN_MODULES must be a JSON array');
  }
  if (
    !Array.isArray(names) ||
    names.length > 50 ||
    names.some(
      (name) =>
        typeof name !== 'string' ||
        name.length > 200 ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name),
    )
  )
    throw new Error('OVO_PLUGIN_MODULES accepts installed package identifiers only');
  return names as string[];
}

/** `Record<pluginId, T>` exports, merged; a plugin id may appear in only one package. */
function mergeById<T>(
  target: Record<string, T>,
  value: unknown,
  label: string,
  check: (v: unknown) => boolean,
) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid installed ${label} registry`);
  for (const [id, item] of Object.entries(value)) {
    if (!id || Object.hasOwn(target, id) || !check(item))
      throw new Error(`Invalid or duplicate installed ${label} for ${id}`);
    target[id] = item as T;
  }
}

/** Installation-owned code only. This never downloads packages or accepts HTTP request input. */
export async function loadInstalledSessionExtensions(
  encoded: string = '[]',
  load: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<InstalledSessionExtensions> {
  const names = parseNames(encoded);
  const result: Required<InstalledSessionExtensions> = {
    plugins: [],
    nativeHandlers: Object.create(null),
    nativeHandlerPackages: [],
    fixtures: Object.create(null),
    fixtureTemplates: Object.create(null),
    unavailable: [],
  };
  const ids = new Set<string>();
  const providers = new Map<string, string>();
  for (const name of names) {
    let module: Record<string, unknown>;
    try {
      module = (await load(name)) as Record<string, unknown>;
    } catch {
      throw new Error(`Installed plugin package could not load: ${name}`);
    }
    if (!module || typeof module !== 'object') throw new Error('Invalid installed plugin module');
    if (module.plugins !== undefined && !Array.isArray(module.plugins))
      throw new Error('Invalid plugin catalog');
    for (const value of (module.plugins ?? []) as PluginDefinition[]) {
      if (!value || typeof value.apply !== 'function')
        throw new Error('Invalid installed plugin definition');
      const definition = definePlugin(value.manifest, value.apply);
      if (ids.has(definition.manifest.id)) throw new Error('Duplicate installed plugin identifier');
      ids.add(definition.manifest.id);
      const { kind, provider } = manifestKeys(definition.manifest).manifest;
      if (provider && SESSION_KINDS.includes(kind)) {
        const pair = `${kind}:${provider}`;
        if (providers.has(pair))
          throw new Error(
            `Duplicate installed ${kind} provider ${provider}: ${providers.get(pair)}, ${definition.manifest.id}`,
          );
        providers.set(pair, definition.manifest.id);
      }
      const reason = unavailableReason(definition.manifest);
      if (reason)
        result.unavailable.push({
          id: definition.manifest.id,
          version: definition.manifest.version,
          reason,
        });
      result.plugins.push(definition);
    }
    mergeById(result.fixtures, module.fixtures, 'fixtures', Array.isArray);
    mergeById(
      result.fixtureTemplates,
      module.fixtureTemplates,
      'fixture template',
      (item) => typeof item === 'function',
    );
    if (module.nativeHandlers === undefined) continue;
    const native = parseNativeHandlers(name, module.nativeHandlers);
    if (ids.has(native.plugin.id))
      throw new Error('Duplicate installed plugin or native handler package identifier');
    ids.add(native.plugin.id);
    const extension: InstalledNativeHandlerPackage = {
      packageName: native.package.name,
      packageVersion: native.package.version,
      pluginId: native.plugin.id,
      pluginVersion: native.plugin.version,
      handlerIds: Object.freeze(Object.keys(native.handlers)),
    };
    result.plugins.push(
      createNativeHandlerMarker({ ...extension, handlerIds: Object.keys(native.handlers) }),
    );
    result.nativeHandlerPackages.push(extension);
    for (const [id, handler] of Object.entries(native.handlers)) {
      if (
        !id ||
        id.length > 120 ||
        typeof handler !== 'function' ||
        Object.hasOwn(result.nativeHandlers, id)
      )
        throw new Error('Invalid or duplicate native handler identifier');
      result.nativeHandlers[id] = handler as NativeToolHandler;
    }
  }
  return result;
}

export function nativeHandlerMarkerService(extension: InstalledNativeHandlerPackage): string {
  return `ovo.native-handlers:${extension.pluginId}@${extension.pluginVersion}`;
}

export function createNativeHandlerMarker(
  extension: InstalledNativeHandlerPackage,
): PluginDefinition {
  const service = nativeHandlerMarkerService(extension);
  return definePlugin(
    {
      id: extension.pluginId,
      version: extension.pluginVersion,
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: [service],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(
        service,
        Object.freeze({
          packageName: extension.packageName,
          packageVersion: extension.packageVersion,
          pluginId: extension.pluginId,
          pluginVersion: extension.pluginVersion,
        }),
      );
    },
  );
}

function parseNativeHandlers(packageName: string, value: unknown): NativeHandlerModuleExport {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid installed native handler registry');
  const native = value as Partial<NativeHandlerModuleExport>;
  if (
    !native.package ||
    native.package.name !== packageName ||
    !VERSION.test(native.package.version) ||
    !native.plugin ||
    native.plugin.id !== `${packageName}/native-handlers` ||
    native.plugin.version !== native.package.version ||
    !native.handlers ||
    typeof native.handlers !== 'object' ||
    Array.isArray(native.handlers)
  )
    throw new Error(
      `Installed native handlers require exact package and plugin identity: ${packageName}`,
    );
  const entries = Object.entries(native.handlers);
  if (!entries.length || entries.length > 100)
    throw new Error('Installed native handler packages require between 1 and 100 handlers');
  if (entries.some(([, handler]) => typeof handler !== 'function'))
    throw new Error('Invalid installed native handler registry');
  return native as NativeHandlerModuleExport;
}
