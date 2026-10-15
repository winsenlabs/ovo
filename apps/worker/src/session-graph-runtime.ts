import {
  Cap,
  meterKey,
  type AudioFormat,
  type PlaybackEvidence,
  type EndReason,
  type EventSink,
  type MediaDuplex,
  type OperationStore,
  type SecretResolver,
  type UsageSink,
  type VoiceMediaTransport,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import type { LoadedDistribution } from '@winsendotai/ovo-distribution';
import { duplexFromLegacy } from '@winsendotai/ovo-plugin-kit';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { selectEngine, selectSessionGraph } from '@winsendotai/ovo-session-host';
import {
  compose,
  createNativeHandlerMarker,
  PluginRegistry,
  type Composition,
  type InstalledSessionExtensions,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';
import { sessionHostServices } from './session-graph-host.ts';
export { subscribeEngineTelemetry } from './session-graph-host.ts';
export type { GraphSessionResult } from './session-graph-host.ts';
import type { GraphSessionResult } from './session-graph-host.ts';
import { immutableMcpConnections } from './production-session-support.ts';
import { instrumentSessionPlugin } from './telemetry-session-plugins.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import { speakerAddedFilters } from './speech-cache-speaker-filters.ts';
import { createV2SpeechCachePlugin } from './speech-cache-v2.ts';
import type { CallClips } from './speech-cache-percall.ts';
import { sessionSttPlugin, type SttPreconnect } from './session-stt-preconnect.ts';
import { stampBindingIdentity, withDerivedSelections } from './session-graph-bindings.ts';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';
import { adaptV1Engine } from './v1-engine-adapter.ts';
import { holdOpeningForAnsweringMachine } from './answering-machine.ts';
import type { CallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import {
  limitCallSeconds,
  prefixEngineEvent,
  withSegmentIds,
  type SegmentGraphShape,
} from './segment-ids.ts';
export type { SegmentGraphShape } from './segment-ids.ts';

export interface LiveGraphOptions {
  distribution: LoadedDistribution;
  parent: Composition;
  carriers?: WorkerCarrierRuntime;
  /** Where each call's outcome events are stored (AGT-8); closed with the worker. */
  outcomes?: Pick<CallOutcomeStore, 'append' | 'close'>;
}

export interface LiveCarrierMedia {
  carrierId: string;
  format: AudioFormat;
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
  /** This call's templated lines, prepared while it rang or at admission (TTS-10). */
  callClips?: CallClips;
  /** The release's STT, already connecting since the media stream opened (STT-6). */
  sttPreconnect?: SttPreconnect;
  carrierMedia: LiveCarrierMedia;
  beforeMediaClose?: (reason: EndReason) => Promise<void>;
  /** Set on an outbound leg dialled with answering-machine detection. */
  amd?: { timeoutMs: number };
  /** The carrier's verdict, from the media link or the durable callback. */
  answeredBy?: NonNullable<MediaDuplex['onAnsweredBy']>;
  /** The call's outcome event sink, offered to the behaviour as `ovo.event-sink`. */
  events?: EventSink;
  segment?: SegmentGraphShape;
}): Promise<GraphSessionResult> {
  const { release, graph, telemetry, segment } = input;
  const prefix = segment?.idPrefix;
  const registry = new PluginRegistry([
    ...graph.distribution.catalog,
    ...input.extensions.plugins,
    ...(input.extensions.nativeHandlerPackages ?? []).map(createNativeHandlerMarker),
  ]);
  const legacyMedia = duplexFromLegacy(
    input.media,
    input.carrierMedia.format,
    input.carrierMedia.playbackEvidence,
    {
      carrierId: input.carrierMedia.carrierId,
      clearFlushesMarkers: input.carrierMedia.clearFlushesMarkers,
    },
  );
  let closing: Promise<void> | undefined;
  const overrides: Partial<Pick<MediaDuplex, 'close' | 'onAnsweredBy'>> = {};
  if (input.beforeMediaClose)
    overrides.close = async (reason: EndReason) => {
      closing ??= input.beforeMediaClose!(reason);
      try {
        await closing;
      } finally {
        await legacyMedia.close(reason);
      }
    };
  // The legacy transport shim has no answering-machine channel; the engine reads it from here.
  if (input.answeredBy) overrides.onAnsweredBy = input.answeredBy;
  const media: MediaDuplex = Object.keys(overrides).length
    ? Object.assign(Object.create(legacyMedia) as MediaDuplex, overrides)
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
    transcripts: (raw) => {
      const event = prefix ? prefixEngineEvent(raw, prefix) : raw;
      if (event.type === 'user.transcript' && event.stability === 'final')
        telemetry.audit('transcript.accepted', { text: event.text, turnId: event.turnId });
      if (event.type === 'agent.transcript')
        telemetry.audit('transcript.agent', { text: event.text, state: event.state });
    },
    ...(input.events ? { events: input.events } : {}),
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
    ? createV2SpeechCachePlugin(
        release,
        input.speechCache.cache,
        telemetry,
        input.callClips
          ? { clips: input.callClips, options: input.speechCache.options.perCall }
          : undefined,
        await speakerAddedFilters(registry),
      )
    : undefined;
  const graphRelease = withDerivedSelections(
    release,
    registry,
    graph.distribution.defaults,
    selected,
  );
  const result = selectSessionGraph({
    release: graphRelease,
    registry,
    hostServices: [host, ...(cachedOutput ? [cachedOutput] : []), ...(segment?.services ?? [])],
    parent: graph.parent.keys,
    media,
    installedExtensions: input.extensions,
    defaults: graph.distribution.defaults,
    mcpConnections: immutableMcpConnections(release, mcpTools),
    sessionVariables: input.variables,
    ...(segment?.behavior ? { behavior: segment.behavior } : {}),
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
  stampBindingIdentity(result.rows, release);
  if (input.amd) holdOpeningForAnsweringMachine(result.rows, selected.definition, input.amd);
  if (segment?.maxCallSeconds !== undefined)
    limitCallSeconds(result.rows, selected.definition, segment.maxCallSeconds);
  const sttPlugin = release.selections?.stt?.pluginId;
  const catalog = result.catalog.map((definition) =>
    instrumentSessionPlugin(
      definition.manifest.id === sttPlugin
        ? sessionSttPlugin(definition, input.variables, input.sttPreconnect)
        : definition,
      telemetry,
    ),
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
  return { composition, engine: prefix ? withSegmentIds(engine, prefix) : engine, media };
}
