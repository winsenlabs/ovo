import { liveSessionRequiresInput } from './live-input-policy.ts';
import type { ToolConnection } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { STREAMING_VOICE_PLUGIN_IDS, VOICE_PLUGIN_IDS } from '@winsendotai/ovo-plugin-voice';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { HYBRID_SPEECH_CACHE_PLUGIN_ID } from './speech-cache-runtime.ts';

const DRIVER_IDS = new Set([
  '@winsendotai/ovo-provider-deepgram-stt',
  '@winsendotai/ovo-provider-openai-tts',
  '@winsendotai/ovo-provider-openai-inference',
  VOICE_PLUGIN_IDS.scheduler,
  STREAMING_VOICE_PLUGIN_IDS.mediaOutput,
  STREAMING_VOICE_PLUGIN_IDS.sessionEngine,
  HYBRID_SPEECH_CACHE_PLUGIN_ID,
]);

export function installedPluginsForRelease(
  release: ReleaseRecord,
  installed: readonly PluginDefinition[],
): PluginDefinition[] {
  const locks = new Map(release.plugins.map((plugin) => [plugin.id, plugin.version]));
  for (const plugin of installed) {
    const pinned = locks.get(plugin.manifest.id);
    if (pinned && pinned !== plugin.manifest.version)
      throw new Error(
        `installed plugin ${plugin.manifest.id}@${plugin.manifest.version} does not satisfy release pin ${pinned}`,
      );
  }
  return installed.filter((plugin) => locks.get(plugin.manifest.id) === plugin.manifest.version);
}

export function validateReleasePlugins(
  release: ReleaseRecord,
  liveCatalog: readonly PluginDefinition[],
): void {
  const live = new Map(liveCatalog.map((plugin) => [plugin.manifest.id, plugin.manifest.version]));
  for (const plugin of liveCatalog) {
    if (DRIVER_IDS.has(plugin.manifest.id)) continue;
    const pinned = release.plugins.find((row) => row.id === plugin.manifest.id);
    if (!pinned || pinned.version !== plugin.manifest.version)
      throw new Error(`live release does not pin ${plugin.manifest.id}@${plugin.manifest.version}`);
  }
  for (const pinned of release.plugins) {
    const installed = live.get(pinned.id);
    if (installed && installed !== pinned.version)
      throw new Error(`live release plugin is not installed: ${pinned.id}@${pinned.version}`);
  }
}

export function uniqueDefinitions(definitions: readonly PluginDefinition[]): PluginDefinition[] {
  const result = new Map<string, PluginDefinition>();
  for (const definition of definitions) {
    const existing = result.get(definition.manifest.id);
    if (existing && existing.manifest.version !== definition.manifest.version)
      throw new Error(`conflicting plugin versions for ${definition.manifest.id}`);
    result.set(definition.manifest.id, definition);
  }
  return [...result.values()];
}

export function immutableMcpConnections(
  release: ReleaseRecord,
  requiredTools: readonly ReleaseRecord['config']['tools'][number][],
): ToolConnection[] {
  const connections = new Map<string, ToolConnection>();
  for (const tool of requiredTools) {
    const snapshot = release.mcpTools[tool.id];
    if (!snapshot) throw new Error(`live release is missing immutable MCP snapshot for ${tool.id}`);
    if (
      snapshot.approval.agentId !== release.agentId ||
      snapshot.approval.toolId !== tool.id ||
      snapshot.approval.connectionId !== snapshot.connection.id ||
      snapshot.approval.schemaDigest !== snapshot.discoveredTool.schemaDigest ||
      tool.connectionId !== snapshot.connection.id ||
      tool.remoteName !== snapshot.discoveredTool.remoteName ||
      tool.schemaDigest !== snapshot.discoveredTool.schemaDigest
    )
      throw new Error(`live release has inconsistent MCP snapshot for ${tool.id}`);
    connections.set(snapshot.connection.id, {
      id: snapshot.connection.id,
      workspaceId: snapshot.connection.workspaceId,
      label: snapshot.connection.label,
      endpoint: snapshot.connection.endpoint,
      auth: snapshot.connection.auth,
      credentialId: snapshot.connection.credentialId ?? undefined,
    });
  }
  return [...connections.values()];
}

export function pluginConfig(
  definition: PluginDefinition,
  release: ReleaseRecord,
  sessionId: string,
  payload: Record<string, unknown>,
) {
  if (definition.manifest.provides.includes('ovo.behavior'))
    return { agent: structuredClone(release.config), workspaceId: release.workspaceId, sessionId };
  if (definition.manifest.id === STREAMING_VOICE_PLUGIN_IDS.sessionEngine) {
    const requiresInput = liveSessionRequiresInput(release.config);
    return {
      language: release.config.language,
      inputEnabled: requiresInput,
      initialInput: release.config.script || !requiresInput ? '' : undefined,
      initialVariables: isRecord(payload.variables) ? structuredClone(payload.variables) : {},
    };
  }
  return {};
}

export function requiredPayloadString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`job payload is missing ${field}`);
  return value;
}

export function optionalPayloadString(
  payload: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = payload[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
