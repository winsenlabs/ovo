import type { AgentConfig, ToolConnection } from '@winsendotai/ovo-contracts';
export { withSessionFixtures, type SessionFixtures } from './fixtures.ts';
export {
  createNativeHandlerMarker,
  loadInstalledSessionExtensions,
  nativeHandlerMarkerService,
  type InstalledNativeHandlerPackage,
  type InstalledSessionExtensions,
} from './installed.ts';
import {
  createNativeHandlerMarker,
  nativeHandlerMarkerService,
  type InstalledNativeHandlerPackage,
} from './installed.ts';
import { BEHAVIOR_PLUGIN_IDS, createBehaviorPluginCatalog } from '@winsendotai/ovo-behaviors';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import {
  createExecutionPlugin,
  createNativeToolsPlugin,
  type NativeToolHandler,
} from '@winsendotai/ovo-plugin-tools';
import { createHttpToolsPlugin, type HttpToolBinding } from '@winsendotai/ovo-plugin-tools-http';
import { createMcpToolsPlugin } from '@winsendotai/ovo-plugin-tools-mcp';
import {
  createSpeechSchedulerPlugin,
  createSimulatedSpeechOutputPlugin,
} from '@winsendotai/ovo-plugin-voice';
import {
  createOpenAiInferenceProviderPlugin,
  openAiInferenceBindingFromRecord,
  type StoredProviderBinding,
} from '@winsendotai/ovo-plugin-providers';

export interface SessionPluginInput {
  config: AgentConfig;
  workspaceId: string;
  /** Immutable release snapshots, keyed by role (inference, stt, tts). */
  bindings: Readonly<Record<string, StoredProviderBinding>>;
  mcpConnections?: readonly ToolConnection[];
  nativeHandlers?: Readonly<Record<string, NativeToolHandler>>;
  nativeHandlerPackages?: readonly InstalledNativeHandlerPackage[];
  /** Immutable release pins. Omit only while constructing a new release graph. */
  releasePlugins?: readonly { id: string; version: string }[];
  /** Live callers must supply a real output; the factory never silently simulates live audio. */
  output: { kind: 'simulation' } | { kind: 'live'; plugin: PluginDefinition };
  /** Operator-installed adapter replacement, not user-authored executable code. */
  inferencePlugin?: PluginDefinition;
  onInferenceUsage?: NonNullable<
    Parameters<typeof createOpenAiInferenceProviderPlugin>[1]
  >['onInferenceUsage'];
}

export function behaviorPluginId(config: AgentConfig): string {
  return config.mode === 'faq' && config.faq.some((entry) => entry.requiresTool)
    ? BEHAVIOR_PLUGIN_IDS.faqTools
    : BEHAVIOR_PLUGIN_IDS[config.mode];
}

/** Select a complete ordinary-plugin graph; the host retains no application capabilities. */
export function createSessionPluginCatalog(input: SessionPluginInput): PluginDefinition[] {
  const { config } = input;
  const behavior = createBehaviorPluginCatalog().find(
    (plugin) => plugin.manifest.id === behaviorPluginId(config),
  )!;
  const plugins: PluginDefinition[] = [behavior];
  const needsExecution =
    config.mode === 'agent' || behavior.manifest.id === BEHAVIOR_PLUGIN_IDS.faqTools;
  if (config.mode === 'context' || config.mode === 'agent') {
    if (input.inferencePlugin) plugins.push(input.inferencePlugin);
    else {
      const binding = input.bindings.inference;
      if (!binding || binding.workspaceId !== input.workspaceId)
        throw new Error('An approved inference binding is required');
      plugins.push(
        createOpenAiInferenceProviderPlugin(openAiInferenceBindingFromRecord(binding), {
          onInferenceUsage: input.onInferenceUsage,
        }),
      );
    }
  }
  if (!needsExecution) return plugins;
  plugins.push(
    createExecutionPlugin({
      tools: config.tools,
      allowedTools: config.allowedTools,
      processing: config.processing,
    }),
  );
  plugins.push(
    createSpeechSchedulerPlugin(),
    input.output.kind === 'simulation' ? createSimulatedSpeechOutputPlugin() : input.output.plugin,
  );
  const allowed = config.tools.filter((tool) => config.allowedTools.includes(tool.id));
  if (allowed.some((tool) => tool.connector === 'native')) {
    const requiredPackages = new Map<string, InstalledNativeHandlerPackage>();
    for (const tool of allowed.filter((tool) => tool.connector === 'native')) {
      if (!Object.hasOwn(input.nativeHandlers ?? {}, tool.id))
        throw new Error(`Native handler is not installed: ${tool.id}`);
      const owners = (input.nativeHandlerPackages ?? []).filter((item) =>
        item.handlerIds.includes(tool.id),
      );
      if (owners.length !== 1)
        throw new Error(`Native handler package identity is unavailable: ${tool.id}`);
      requiredPackages.set(owners[0]!.pluginId, owners[0]!);
    }
    for (const extension of requiredPackages.values()) {
      if (input.releasePlugins) {
        const pinned = input.releasePlugins.find((item) => item.id === extension.pluginId);
        if (!pinned || pinned.version !== extension.pluginVersion)
          throw new Error(
            `Pinned native handler package is not installed: ${extension.pluginId}@${pinned?.version ?? 'missing'}`,
          );
      }
      plugins.push(createNativeHandlerMarker(extension));
    }
    const native = createNativeToolsPlugin(input.nativeHandlers ?? {});
    plugins.push(
      definePlugin(
        {
          ...native.manifest,
          requires: [
            ...native.manifest.requires,
            ...[...requiredPackages.values()].map(nativeHandlerMarkerService),
          ],
        },
        native.apply,
      ),
    );
  }
  const http = allowed.filter((tool) => tool.connector === 'http');
  if (http.length) {
    const bindings: HttpToolBinding[] = http.map((tool) => {
      if (!tool.http) throw new Error(`HTTP binding is required: ${tool.id}`);
      return {
        toolId: tool.id,
        workspaceId: input.workspaceId,
        endpoint: tool.http.endpoint,
        method: tool.http.method,
        body: tool.http.method === 'GET' ? 'none' : 'input',
        auth: tool.http.credentialId
          ? { type: 'bearer', credentialId: tool.http.credentialId }
          : undefined,
        idempotencyHeader: tool.http.idempotencyHeader,
        response: { type: tool.http.responseType, pointer: tool.http.responsePointer },
      };
    });
    plugins.push(createHttpToolsPlugin(bindings));
  }
  const mcp = allowed.filter((tool) => tool.connector === 'mcp');
  if (mcp.length) {
    const ids = new Set(mcp.map((tool) => tool.connectionId));
    const connections = (input.mcpConnections ?? []).filter((connection) => ids.has(connection.id));
    if (
      connections.some((connection) => connection.workspaceId !== input.workspaceId) ||
      [...ids].some((id) => !id || !connections.some((connection) => connection.id === id))
    )
      throw new Error('An approved MCP connection is missing');
    plugins.push(createMcpToolsPlugin(connections));
  }
  return plugins;
}
