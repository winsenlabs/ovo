import {
  Cap,
  MULAW_8K,
  meterKey,
  type PlaybackEvidence,
  type Clock,
  type EngineEvent,
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
import { decorateByKind, selectEngine, selectSessionGraph } from '@winsendotai/ovo-session-host';
import {
  compose,
  createNativeHandlerMarker,
  definePlugin,
  manifestKeys,
  PluginRegistry,
  type Composition,
  type InstalledSessionExtensions,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';
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

export interface GraphSessionResult {
  composition: Composition;
  engine: VoiceSessionEngine;
  media: MediaDuplex;
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
}): Promise<GraphSessionResult> {
  const { release, graph, telemetry } = input;
  const registry = new PluginRegistry([
    ...graph.distribution.catalog,
    ...input.extensions.plugins,
    ...(input.extensions.nativeHandlerPackages ?? []).map(createNativeHandlerMarker),
  ]);
  const media = duplexFromLegacy(input.media, MULAW_8K, input.carrierMedia.playbackEvidence, {
    carrierId: input.carrierMedia.carrierId,
    clearFlushesMarkers: input.carrierMedia.clearFlushesMarkers,
  });
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
    release,
    registry,
    input.extensions,
    () => registry.get('@winsendotai/ovo-plugin-voice-session-engine')!,
    input.variables,
  );
  const cachedOutput = input.speechCache
    ? createV2SpeechCachePlugin(release, input.speechCache.cache)
    : undefined;
  const result = selectSessionGraph({
    release,
    registry,
    hostServices: cachedOutput ? [host, cachedOutput] : [host],
    parent: graph.parent.keys,
    media,
    installedExtensions: input.extensions,
    defaults: graph.distribution.defaults,
    mcpConnections: immutableMcpConnections(release, mcpTools),
    sessionVariables: input.variables,
  });
  if (release.selections?.engine && selected.definition.manifest.id !== result.resolved.engine?.id)
    throw new Error('selected session engine differs from release graph');
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

export function subscribeEngineTelemetry(
  engine: VoiceSessionEngine,
  telemetry: WorkerSessionTelemetry,
  speech?: (event: Extract<EngineEvent, { type: 'speech' }>) => void,
): () => void {
  return engine.subscribe((event) => {
    if (event.type === 'speech') {
      telemetry.adapter.speech(event.evidence);
      speech?.(event);
    } else if (event.type === 'timing') {
      telemetry.audit('session.timing', { key: event.key, atMs: event.atMs, ms: event.ms });
    } else if (event.type === 'user.transcript') {
      telemetry.audit('transcript.accepted', { text: event.text, turnId: event.turnId });
    } else if (event.type === 'end') {
      telemetry.audit('session.engine-ended', { reason: event.reason });
    }
  });
}

function sessionHostServices(input: {
  media: MediaDuplex;
  operationStore: OperationStore;
  secrets: SecretResolver;
  usage: UsageSink;
  transcripts: (
    event: Extract<EngineEvent, { type: 'user.transcript' | 'agent.transcript' }>,
  ) => void;
}): PluginDefinition {
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const timer = globalThis.setTimeout(fn, ms);
      return () => globalThis.clearTimeout(timer);
    },
  };
  return definePlugin(
    {
      id: '@winsendotai/ovo-worker/session-host-services',
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      requires: [],
      provides: [Cap.operationStore, Cap.secrets, Cap.media, Cap.usage, Cap.transcripts, Cap.clock],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.operationStore, input.operationStore);
      ctx.provide(Cap.secrets, input.secrets);
      ctx.provide(Cap.media, input.media);
      ctx.provide(Cap.usage, input.usage);
      ctx.provide(Cap.transcripts, input.transcripts);
      ctx.provide(Cap.clock, clock);
    },
  );
}
