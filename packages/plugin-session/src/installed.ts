import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { NativeToolHandler } from '@winsendotai/ovo-plugin-tools';

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
}

interface NativeHandlerModuleExport {
  package: { name: string; version: string };
  plugin: { id: string; version: string };
  handlers: Record<string, NativeToolHandler>;
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** Installation-owned code only. This never downloads packages or accepts HTTP request input. */
export async function loadInstalledSessionExtensions(
  encoded: string = '[]',
  load: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<InstalledSessionExtensions> {
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
  const result: InstalledSessionExtensions = {
    plugins: [],
    nativeHandlers: Object.create(null),
    nativeHandlerPackages: [],
  };
  const ids = new Set<string>();
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
      result.plugins.push(definition);
    }
    if (module.nativeHandlers === undefined) continue;
    const native = parseNativeHandlers(name, module.nativeHandlers);
    if (ids.has(native.plugin.id))
      throw new Error('Duplicate installed plugin or native handler package identifier');
    ids.add(native.plugin.id);
    const marker = createNativeHandlerMarker({
      packageName: native.package.name,
      packageVersion: native.package.version,
      pluginId: native.plugin.id,
      pluginVersion: native.plugin.version,
      handlerIds: Object.keys(native.handlers),
    });
    result.plugins.push(marker);
    result.nativeHandlerPackages!.push({
      packageName: native.package.name,
      packageVersion: native.package.version,
      pluginId: native.plugin.id,
      pluginVersion: native.plugin.version,
      handlerIds: Object.freeze(Object.keys(native.handlers)),
    });
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
