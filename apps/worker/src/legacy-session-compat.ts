import { Cap, type VoiceMediaTransport } from '@winsendotai/ovo-contracts';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { compose, type InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import { createSessionPluginCatalog } from '@winsendotai/ovo-session-host';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';
import {
  immutableMcpConnections,
  installedPluginsForRelease,
  pluginConfig,
  selectVoiceSessionEnginePlugin,
  uniqueDefinitions,
  validateReleasePlugins,
} from './production-session-support.ts';

/** Exact v1 engine pins remain runnable while production sessions use selected v2 graphs. */
export async function composeLegacySessionGraph(input: {
  job: DurableJob;
  route: SessionRoute;
  release: ReleaseRecord;
  media: VoiceMediaTransport;
  telemetry: WorkerSessionTelemetry;
  store: ControlStore;
  extensions: InstalledSessionExtensions;
}) {
  const { release } = input;
  const mcpTools = release.config.tools.filter(
    (tool) => tool.connector === 'mcp' && release.config.allowedTools.includes(tool.id),
  );
  const sessionCatalog = createSessionPluginCatalog({
    config: release.config,
    workspaceId: release.workspaceId,
    bindings: release.providerBindings,
    mcpConnections: immutableMcpConnections(release, mcpTools),
    nativeHandlers: input.extensions.nativeHandlers,
    nativeHandlerPackages: input.extensions.nativeHandlerPackages,
    releasePlugins: release.plugins,
    output: { kind: 'host' },
  });
  const installed = installedPluginsForRelease(release, input.extensions.plugins);
  validateReleasePlugins(release, [...sessionCatalog, ...installed]);
  const engine = selectVoiceSessionEnginePlugin(release, input.extensions.plugins, () => {
    throw new Error('A production v2 graph is required for the built-in engine');
  });
  if (!engine.manifest.provides.some((key) => key.split('@')[0] === Cap.engine))
    throw new Error('Selected legacy engine does not provide a voice session engine');
  const catalog = uniqueDefinitions([...sessionCatalog, ...installed, engine]);
  const rows = catalog
    .filter((definition) => definition.manifest.scope === 'session')
    .map((definition) => ({
      id: definition.manifest.id,
      config: pluginConfig(definition, release, input.route.sessionId, input.job.payload),
    }));
  const composition = await compose(rows, catalog);
  const created = composition.ctx.get(Cap.engine) as { dispose(reason?: string): Promise<unknown> };
  if (!created) {
    await composition.dispose();
    throw new Error('live plugin graph did not create a voice session engine');
  }
  input.telemetry.audit('session.driver-bound', {
    releaseId: release.id,
    sessionId: input.route.sessionId,
    generation: input.route.generation,
    media: 'live',
  });
  return { composition, engine: created };
}
