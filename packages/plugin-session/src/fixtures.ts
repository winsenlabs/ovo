import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { AgentConfig, InferenceReply } from '@winsendotai/ovo-contracts';

export interface SessionFixtures {
  modelReplies?: InferenceReply[];
  toolResults?: Record<string, unknown>;
}

/** Explicit sandbox replacements preserve the release graph but never contact a provider/tool. */
export function withSessionFixtures(
  config: AgentConfig,
  catalog: readonly PluginDefinition[],
  fixture: SessionFixtures,
): PluginDefinition[] {
  const replies = structuredClone(fixture.modelReplies ?? []);
  const results = structuredClone(fixture.toolResults ?? {});
  return catalog.map((definition) => {
    const inference = definition.manifest.provides.includes('ovo.inference');
    const connector = definition.manifest.provides.find((service) =>
      service.startsWith('ovo.tool-connector.'),
    );
    if (!inference && !connector) return definition;
    return definePlugin(definition.manifest, (ctx) => {
      if (inference)
        ctx.provide('ovo.inference', {
          generate: async () => replies.shift() ?? { kind: 'text', text: config.uncertainty },
        });
      if (connector)
        ctx.provide(connector, {
          invoke: async (tool: { id: string }) => {
            if (!Object.hasOwn(results, tool.id))
              throw new Error(`Simulation fixture is missing for ${tool.id}`);
            return structuredClone(results[tool.id]);
          },
        });
    });
  });
}
