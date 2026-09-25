import {
  Cap,
  capabilitySpec,
  type AgentConfig,
  type MediaDuplex,
  type ReleaseSelection,
  type ReleaseSelections,
  type SessionInput,
  type ToolConnection,
} from '@winsendotai/ovo-contracts';
import {
  definePlugin,
  manifestKeys,
  PluginRegistry,
  resolveGraph,
  type InstalledSessionExtensions,
  type PluginDefinition,
  type PluginRow,
} from '@winsendotai/ovo-runtime';
import { behaviorPluginId, createSessionPluginCatalog } from './session-catalog.ts';
import { legacySelections } from './legacy-session-selections.ts';
import type { NormalizationBinding, SessionDefaults } from './normalize.ts';
import { adaptDefinitionFormats } from './speech-adapters/decorate.ts';
import { sessionRequiresInput } from './input-policy.ts';
import { STREAMING_VOICE_PLUGIN_IDS } from '@winsendotai/ovo-plugin-voice';

export interface SessionGraphRelease {
  id: string;
  workspaceId: string;
  config: AgentConfig;
  plugins: readonly { id: string; version: string }[];
  selections?: ReleaseSelections;
  providerBindings?: Readonly<
    Record<
      string,
      NormalizationBinding & {
        config?: Record<string, unknown>;
        credentialId?: string;
        updatedAt?: string;
      }
    >
  >;
}

export interface SessionGraphInput {
  release: SessionGraphRelease;
  registry: PluginRegistry;
  hostServices: readonly PluginDefinition[];
  /** Only process/either keys are inherited. Session keys get a real host-service row. */
  parent: Iterable<string>;
  media: MediaDuplex;
  fixtures?: boolean;
  installedExtensions: InstalledSessionExtensions;
  defaults?: SessionDefaults;
  mcpConnections?: readonly ToolConnection[];
  sessionVariables?: Readonly<Record<string, unknown>>;
}

export interface SessionGraphResult {
  rows: PluginRow[];
  catalog: PluginDefinition[];
  resolved: Record<string, { id: string; version: string; exact: boolean }>;
}

export class ReleasePluginUnavailableError extends Error {
  readonly code = 'release.plugin_unavailable';
  constructor(
    readonly pluginId: string,
    reason: string,
  ) {
    super(`${pluginId}: ${reason}`);
    this.name = 'ReleasePluginUnavailableError';
  }
}

function mediaDefinition(media: MediaDuplex): PluginDefinition {
  return definePlugin(
    {
      id: '@winsendotai/ovo-host-media',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      provides: [Cap.media],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.media, media);
    },
  );
}

function configFor(
  slot: string,
  selection: ReleaseSelection,
  config: AgentConfig,
  variables: Readonly<Record<string, unknown>>,
  bindings: SessionGraphRelease['providerBindings'],
): Record<string, unknown> {
  if (slot === 'engine') {
    const session: SessionInput = {
      mode: config.mode,
      language: config.language,
      inputEnabled: sessionRequiresInput(config),
      variables: structuredClone(variables),
      maxCallSeconds: config.costPolicy?.maxCallSeconds ?? 1800,
      acknowledgements: config.voice?.acknowledgements ?? [],
    };
    return { session, engine: selection.config };
  }
  if (slot === 'turnDetector') return selection.config;
  const binding =
    selection.binding ??
    Object.values(bindings ?? {}).find((row) => row.id === selection.bindingId);
  return {
    ...(binding
      ? {
          binding: binding.config ?? {},
          ...(binding.credentialId
            ? { credentialRef: { credentialId: binding.credentialId } }
            : {}),
        }
      : {}),
    ...selection.config,
  };
}

/** Resolve the immutable release graph without starting a provider or opening a socket. */
export function selectSessionGraph(input: SessionGraphInput): SessionGraphResult {
  const release = input.release;
  const legacy = !Object.keys(release.selections ?? {}).length;
  let selections: ReleaseSelections;
  try {
    selections = legacy ? legacySelections(input) : release.selections!;
  } catch (error) {
    throw new ReleasePluginUnavailableError(
      'legacy-selection',
      error instanceof Error ? error.message : String(error),
    );
  }
  const rows: PluginRow[] = [];
  const catalog: PluginDefinition[] = [];
  const resolved: SessionGraphResult['resolved'] = {};
  const add = (definition: PluginDefinition, config: Record<string, unknown>) => {
    if (catalog.some((item) => item.manifest.id === definition.manifest.id)) return;
    catalog.push(definition);
    if (definition.manifest.scope === 'session') rows.push({ id: definition.manifest.id, config });
  };
  for (const [slot, selection] of Object.entries(selections)) {
    if (!selection) continue;
    let pinned;
    try {
      pinned = legacy
        ? { definition: input.registry.get(selection.pluginId), exact: false }
        : input.registry.resolvePin(selection.pluginId, selection.version);
    } catch (error) {
      throw new ReleasePluginUnavailableError(
        selection.pluginId,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!pinned.definition)
      throw new ReleasePluginUnavailableError(selection.pluginId, 'plugin is not installed');
    const definition = pinned.definition;
    resolved[slot] = {
      id: definition.manifest.id,
      version: definition.manifest.version,
      exact: pinned.exact,
    };
    add(
      adaptDefinitionFormats(definition),
      configFor(
        slot,
        selection,
        release.config,
        input.sessionVariables ?? {},
        release.providerBindings,
      ),
    );
    if (slot !== 'engine') continue;
    for (const [key, id] of Object.entries(
      manifestKeys(definition.manifest).manifest.companions ?? {},
    )) {
      let companion;
      try {
        companion = input.registry.resolvePin(id, definition.manifest.version);
      } catch (error) {
        throw new ReleasePluginUnavailableError(
          id,
          error instanceof Error ? error.message : String(error),
        );
      }
      resolved[`companion:${key}`] = {
        id: companion.definition.manifest.id,
        version: companion.definition.manifest.version,
        exact: companion.exact,
      };
      if (
        input.hostServices.some((service) =>
          manifestKeys(service.manifest).provides.some((entry) => entry.key === key),
        )
      ) {
        if (!catalog.some((item) => item.manifest.id === companion.definition.manifest.id))
          catalog.push(companion.definition);
      } else
        add(
          companion.definition,
          id === STREAMING_VOICE_PLUGIN_IDS.mediaOutput &&
            release.config.voice?.acknowledgements.includes('weak-playback-evidence')
            ? { allowWeakEvidence: true }
            : {},
        );
    }
  }
  for (const definition of createSessionPluginCatalog({
    config: release.config,
    workspaceId: release.workspaceId,
    bindings: release.providerBindings ?? {},
    mcpConnections: input.mcpConnections,
    nativeHandlers: input.installedExtensions.nativeHandlers,
    nativeHandlerPackages: input.installedExtensions.nativeHandlerPackages,
    releasePlugins: release.plugins,
    output: { kind: 'host' },
    inferencePlugin: catalog.find((definition) =>
      manifestKeys(definition.manifest).provides.some((entry) => entry.key === Cap.inference),
    ),
  }))
    add(
      definition,
      definition.manifest.id === behaviorPluginId(release.config)
        ? {
            agent: release.config,
            workspaceId: release.workspaceId,
            sessionId: input.media.sessionId,
          }
        : {},
    );
  const selectedIds = new Set(rows.map((row) => row.id));
  const needed = new Set(
    catalog
      .filter((definition) => selectedIds.has(definition.manifest.id))
      .flatMap((definition) => {
        const keys = manifestKeys(definition.manifest);
        return [...keys.requires, ...keys.optional].map((entry) => entry.key);
      }),
  );
  const services = [...input.hostServices];
  if (
    !services.some((definition) =>
      manifestKeys(definition.manifest).provides.some((p) => p.key === Cap.media),
    )
  )
    services.push(mediaDefinition(input.media));
  const addedServices = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const service of services) {
      if (addedServices.has(service.manifest.id)) continue;
      const keys = manifestKeys(service.manifest);
      if (!keys.provides.some((entry) => needed.has(entry.key))) continue;
      add(service, {});
      addedServices.add(service.manifest.id);
      for (const entry of [...keys.requires, ...keys.optional]) needed.add(entry.key);
      changed = true;
    }
  }
  const parentKeys = [...input.parent].filter((key) => capabilitySpec(key).scope !== 'session');
  resolveGraph(rows, catalog, { parentKeys });
  return { rows, catalog, resolved };
}
