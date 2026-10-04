import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import {
  Cap,
  CAP_PREFIXES,
  type AgentConfig,
  type InferenceReply,
} from '@winsendotai/ovo-contracts';

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
    const inference = definition.manifest.provides.includes(Cap.inference);
    const connector = definition.manifest.provides.find((service) =>
      service.startsWith(CAP_PREFIXES.toolConnector),
    );
    if (!inference && !connector) return definition;
    return definePlugin(definition.manifest, (ctx) => {
      if (inference)
        ctx.provide(Cap.inference, {
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
