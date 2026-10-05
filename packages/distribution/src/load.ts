import {
  loadInstalledSessionExtensions,
  type PluginDefinition,
  type PluginRow,
  type UnavailablePlugin,
} from '@winsendotai/ovo-runtime';
import type { FixtureTemplate, NetFixtureScript } from '@winsendotai/ovo-contracts';
import { FIRST_PARTY, type CatalogEntry, type DistributionRole } from './catalog.ts';
import { DISTRIBUTION_DEFAULTS } from './defaults.ts';
import { envCarrierBindings } from './env-bindings.ts';
import { rows as apiRows } from './profiles/api.ts';
import { rows as workerRows } from './profiles/worker.ts';
import { rows as gatewayRows } from './profiles/gateway.ts';
import { rows as dispatcherRows } from './profiles/dispatcher.ts';
import type { DeploymentProfile, Environment, ProfileRows } from './profiles/types.ts';
import { recordingRows } from './profiles/recordings.ts';

const PROFILE_ROWS: Record<DistributionRole, ProfileRows> = {
  api: apiRows,
  worker: workerRows,
  gateway: gatewayRows,
  dispatcher: dispatcherRows,
};
type LoadedModule = {
  plugins?: readonly PluginDefinition[];
  nativeHandlers?: unknown;
  fixtures?: Record<string, NetFixtureScript[]>;
  fixtureTemplates?: Record<string, FixtureTemplate>;
};

export interface LoadDistributionInput {
  role: DistributionRole;
  profile: DeploymentProfile;
  env: Environment;
  /** Test seam for catalog validation. */
  firstParty?: readonly CatalogEntry[];
  /** Startup log line sink; defaults to one JSON line on stdout. */
  log?: (entry: Record<string, unknown>) => void;
}

export interface LoadedDistribution {
  catalog: PluginDefinition[];
  processRows: PluginRow[];
  defaults: typeof DISTRIBUTION_DEFAULTS;
  fixtures: Record<string, NetFixtureScript[]>;
  fixtureTemplates: Record<string, FixtureTemplate>;
  unavailable: UnavailablePlugin[];
}

/** The one loading path for built-ins and installed extensions. */
export async function loadDistribution(input: LoadDistributionInput): Promise<LoadedDistribution> {
  const bindings = envCarrierBindings(input.env),
    env = bindings.env;
  // Names only, never values: an unexpected env carrier is otherwise invisible until a 403.
  if (
    input.env.OVO_CARRIER_ENV_BINDINGS !== undefined ||
    bindings.ignored.length ||
    bindings.active.length
  )
    (input.log ?? ((entry) => console.log(JSON.stringify(entry))))({
      event: 'carrier_env_bindings',
      role: input.role,
      active: bindings.active,
      ignoredPlaceholders: bindings.ignored,
    });
  const entries = (input.firstParty ?? FIRST_PARTY).filter((entry) => {
    if (
      entry.package === '@winsendotai/ovo-plugin-recordings' &&
      recordingRows(input.profile, env).length === 0
    )
      return false;
    return entry.roles.includes('session') || entry.roles.includes(input.role);
  });
  const modules = new Map<string, LoadedModule>();
  const catalogNames = new Set<string>();
  for (const entry of entries) {
    if (catalogNames.has(entry.package))
      throw new Error(`Duplicate catalog package ${entry.package}`);
    catalogNames.add(entry.package);
    const module = (await entry.load()) as LoadedModule;
    if (
      !module ||
      typeof module !== 'object' ||
      (module.plugins !== undefined && !Array.isArray(module.plugins))
    )
      throw new Error(`Invalid plugin catalog package ${entry.package}`);
    // The runtime's external module parser accepts package ids only. Internal catalog subpaths
    // use stable synthetic ids; their real package names remain in FIRST_PARTY and the lockfile.
    const loaderName =
      entry.package.split('/').length > 2 ? `ovo-catalog-subpath-${modules.size}` : entry.package;
    modules.set(loaderName, module);
  }
  const names = [...modules.keys()];
  const encoded = env.OVO_PLUGIN_MODULES ?? '[]';
  const extensionNames = JSON.parse(encoded) as unknown;
  if (!Array.isArray(extensionNames)) throw new Error('OVO_PLUGIN_MODULES must be a JSON array');
  for (const name of extensionNames) {
    if (typeof name === 'string' && catalogNames.has(name))
      throw new Error(`OVO_PLUGIN_MODULES duplicates catalog package ${name}`);
  }
  const installed = await loadInstalledSessionExtensions(
    JSON.stringify([...names, ...extensionNames]),
    (specifier) => Promise.resolve(modules.get(specifier) ?? import(specifier)),
  );
  const processRows = new Map<string, PluginRow>();
  for (const plugin of installed.plugins) {
    if (plugin.manifest.scope === 'process')
      processRows.set(plugin.manifest.id, { id: plugin.manifest.id });
  }
  for (const row of PROFILE_ROWS[input.role](input.profile, env)) {
    if (!installed.plugins.some((plugin) => plugin.manifest.id === row.id))
      throw new Error(`Profile plugin is not installed: ${row.id}`);
    processRows.set(row.id, row);
  }
  return {
    catalog: installed.plugins,
    processRows: [...processRows.values()],
    defaults: DISTRIBUTION_DEFAULTS,
    fixtures: installed.fixtures ?? {},
    fixtureTemplates: installed.fixtureTemplates ?? {},
    unavailable: installed.unavailable ?? [],
  };
}
