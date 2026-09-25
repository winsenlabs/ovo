import {
  Cap,
  MULAW_8K,
  meterKey,
  type PlaybackEvidence,
  type EndReason,
  type MediaDuplex,
  type OperationStore,
  type SecretResolver,
  type UsageSink,
  type VoiceMediaTransport,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import type { LoadedDistribution } from '@winsendotai/ovo-distribution';
import { duplexFromLegacy } from '@winsendotai/ovo-plugin-kit';
import { deriveLegacySelections, type ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { decorateByKind, selectEngine, selectSessionGraph } from '@winsendotai/ovo-session-host';
import {
  compose,
  createNativeHandlerMarker,
  manifestKeys,
  PluginRegistry,
  type Composition,
  type InstalledSessionExtensions,
} from '@winsendotai/ovo-runtime';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';
import { sessionHostServices } from './session-graph-host.ts';
export { subscribeEngineTelemetry } from './session-graph-host.ts';
export type { GraphSessionResult } from './session-graph-host.ts';
import type { GraphSessionResult } from './session-graph-host.ts';
import { immutableMcpConnections } from './production-session-support.ts';
import {
  instrumentInferencePlugin,
  instrumentSttPlugin,
  instrumentTtsPlugin,
} from './telemetry-stages.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import { createV2SpeechCachePlugin } from './speech-cache-v2.ts';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';
import { adaptV1Engine } from './v1-engine-adapter.ts';

export interface LiveGraphOptions {
  distribution: LoadedDistribution;
  parent: Composition;
  carriers?: WorkerCarrierRuntime;
}

export interface LiveCarrierMedia {
  carrierId: string;
  playbackEvidence: PlaybackEvidence;
  clearFlushesMarkers: boolean | 'unknown';
}

/** The production session path selects every release row before any provider is applied. */
export async function composeLiveSessionGraph(input: {
  graph: LiveGraphOptions;
  release: ReleaseRecord;
  routeSessionId: string;
  variables: Readonly<Record<string, unknown>>;
  media: VoiceMediaTransport;
  operationStore: OperationStore;
  secrets: SecretResolver;
  telemetry: WorkerSessionTelemetry;
  extensions: InstalledSessionExtensions;
  usage?: UsageSink;
  speechCache?: WorkerSpeechCacheRuntime;
  carrierMedia: LiveCarrierMedia;
  beforeMediaClose?: (reason: EndReason) => Promise<void>;
}): Promise<GraphSessionResult> {
  const { release, graph, telemetry } = input;
  const registry = new PluginRegistry([
    ...graph.distribution.catalog,
    ...input.extensions.plugins,
    ...(input.extensions.nativeHandlerPackages ?? []).map(createNativeHandlerMarker),
  ]);
  const legacyMedia = duplexFromLegacy(input.media, MULAW_8K, input.carrierMedia.playbackEvidence, {
    carrierId: input.carrierMedia.carrierId,
    clearFlushesMarkers: input.carrierMedia.clearFlushesMarkers,
  });
  let closing: Promise<void> | undefined;
  const media: MediaDuplex = input.beforeMediaClose
    ? Object.assign(Object.create(legacyMedia) as MediaDuplex, {
        close: async (reason: EndReason) => {
          closing ??= input.beforeMediaClose!(reason);
          try {
            await closing;
          } finally {
            await legacyMedia.close(reason);
          }
        },
      })
    : legacyMedia;
  const usage: UsageSink = (event) => {
    input.usage?.(event);
    telemetry.providerUsage(event);
    telemetry.audit('provider.meter', { key: meterKey(event), ...event });
  };
  const host = sessionHostServices({
    media,
    operationStore: input.operationStore,
    secrets: input.secrets,
    usage,
    transcripts: (event) => {
      if (event.type === 'user.transcript' && event.stability === 'final')
        telemetry.audit('transcript.accepted', { text: event.text, turnId: event.turnId });
      if (event.type === 'agent.transcript')
        telemetry.audit('transcript.agent', { text: event.text, state: event.state });
    },
  });
  const mcpTools = release.config.tools.filter(
    (tool) => tool.connector === 'mcp' && release.config.allowedTools.includes(tool.id),
  );
  // selectEngine checks v1 exact pins and v2 major compatibility before graph composition.
  const selected = selectEngine(
    {
      ...release,
      // Native package pins are checked by createSessionPluginCatalog, which can report
      // the exact missing marker or package identity before graph resolution.
      plugins: release.plugins.filter((pin) => !pin.id.endsWith('/native-handlers')),
    },
    registry,
    input.extensions,
    () => registry.get('@winsendotai/ovo-plugin-voice-session-engine')!,
    input.variables,
  );
  const cachedOutput = input.speechCache
    ? createV2SpeechCachePlugin(release, input.speechCache.cache)
    : undefined;
  const graphRelease: ReleaseRecord =
    !release.selections?.engine && selected.definition.manifest.contractVersion === 1
      ? {
          ...release,
          selections: {
            ...Object.fromEntries(
              Object.entries(
                deriveLegacySelections(release, registry, {
                  engine: graph.distribution.defaults.engine,
                  turnDetector: graph.distribution.defaults.turnDetector,
                }),
              ).map(([slot, choice]) => [
                slot,
                {
                  ...choice,
                  version: registry.get(choice.pluginId)!.manifest.version,
                },
              ]),
            ),
            engine: {
              pluginId: selected.definition.manifest.id,
              version: selected.definition.manifest.version,
              config: selected.rowConfig,
            },
          },
        }
      : release;
  const result = selectSessionGraph({
    release: graphRelease,
    registry,
    hostServices: cachedOutput ? [host, cachedOutput] : [host],
    parent: graph.parent.keys,
    media,
    installedExtensions: input.extensions,
    defaults: graph.distribution.defaults,
    mcpConnections: immutableMcpConnections(release, mcpTools),
    sessionVariables: input.variables,
  });
  const allowedNativeIds = new Set(
    release.config.tools
      .filter(
        (tool) => tool.connector === 'native' && release.config.allowedTools.includes(tool.id),
      )
      .map((tool) => tool.id),
  );
  const allowedPackages =
    input.extensions.nativeHandlerPackages?.filter((extension) =>
      extension.handlerIds.some((id) => allowedNativeIds.has(id)),
    ) ?? [];
  for (const pin of release.plugins.filter((item) => item.id.endsWith('/native-handlers')))
    if (
      !allowedPackages.some(
        (extension) => extension.pluginId === pin.id && extension.pluginVersion === pin.version,
      )
    )
      throw new Error(`Pinned native handler package is not installed: ${pin.id}@${pin.version}`);
  if (release.selections?.engine && selected.definition.manifest.id !== result.resolved.engine?.id)
    throw new Error('selected session engine differs from release graph');
  if (selected.definition.manifest.contractVersion === 1) {
    const row = result.rows.find((item) => item.id === selected.definition.manifest.id);
    if (row) row.config = selected.rowConfig;
  }
  if (
    !release.selections?.engine &&
    selected.definition.manifest.id !== result.resolved.engine?.id
  ) {
    result.rows = result.rows.filter((row) => row.id !== result.resolved.engine?.id);
    result.rows.push({ id: selected.definition.manifest.id, config: selected.rowConfig });
    result.catalog.push(selected.definition);
  }
  // Legacy bridges need the immutable binding identity as well as the copied config.
  for (const [slot, selection] of Object.entries(release.selections ?? {})) {
    if (!selection?.binding) continue;
    const row = result.rows.find((item) => item.id === selection.pluginId);
    if (row)
      row.config = {
        ...row.config,
        workspaceId: release.workspaceId,
        bindingId: selection.bindingId,
        updatedAt: selection.binding.updatedAt,
      };
  }
  for (const binding of Object.values(release.providerBindings)) {
    const row = result.rows.find(
      (item) =>
        item.config?.credentialRef &&
        (item.config.credentialRef as { credentialId?: string }).credentialId ===
          binding.credentialId,
    );
    if (row)
      row.config = {
        ...row.config,
        workspaceId: release.workspaceId,
        bindingId: binding.id,
        updatedAt: binding.updatedAt,
      };
  }
  const catalog = result.catalog.map((definition) =>
    decorateByKind(definition, {
      stt: (item) =>
        instrumentSttPlugin(item, telemetry, {
          provider: manifestKeys(item.manifest).manifest.provider,
        }),
      tts: (item) =>
        instrumentTtsPlugin(item, telemetry, {
          provider: manifestKeys(item.manifest).manifest.provider,
        }),
      llm: (item) =>
        instrumentInferencePlugin(item, telemetry, {
          provider: manifestKeys(item.manifest).manifest.provider,
        }),
    }),
  );
  const composition = await compose(result.rows, catalog, {
    scope: 'session',
    parent: graph.parent,
    workspaceId: release.workspaceId,
  });
  const provided = composition.ctx.get(Cap.engine) as VoiceSessionEngine | undefined;
  const engine =
    provided && selected.definition.manifest.contractVersion === 1
      ? adaptV1Engine(provided)
      : provided;
  if (!engine || typeof engine.subscribe !== 'function') {
    await composition.dispose();
    throw new Error('Selected live engine does not expose the v2 session contract');
  }
  return { composition, engine, media };
}
