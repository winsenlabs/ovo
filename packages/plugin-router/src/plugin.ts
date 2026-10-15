import {
  AgentConfig,
  Cap,
  RoutingReleaseSnapshot,
  type DecisionPort,
  type EventSink,
  type Inference,
  type RoutingHost,
  type SegmentHandoffPort,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { RouterBehavior } from './behavior.ts';
import { RouterCore } from './core.ts';
import { createEngineRunners } from './engines/index.ts';

export const ROUTER_BEHAVIOR_PLUGIN_ID = '@winsendotai/ovo-behavior-router';

/** What the worker composes the router behaviour with (§7.3): the router release and the snapshot. */
export interface RouterPluginConfig {
  /** The router release's agent config. Only its timezone is read; its prompt, opening and tools are not. */
  agent: AgentConfig;
  workspaceId: string;
  sessionId: string;
  routing: RoutingReleaseSnapshot;
}

export const routerConfigSchema = {
  type: 'object',
  required: ['agent', 'workspaceId', 'sessionId', 'routing'],
  properties: {
    agent: { type: 'object' },
    workspaceId: { type: 'string', minLength: 1 },
    sessionId: { type: 'string', minLength: 1 },
    routing: { type: 'object' },
  },
  additionalProperties: false,
} as const;

export function parseRouterConfig(config: Record<string, unknown>): RouterPluginConfig {
  const unknown = Object.keys(config).find((key) => !(key in routerConfigSchema.properties));
  if (unknown) throw new TypeError(`Unknown router plugin config field: ${unknown}`);
  for (const key of ['workspaceId', 'sessionId'] as const)
    if (typeof config[key] !== 'string' || !config[key])
      throw new TypeError(`Router plugin requires ${key}`);
  return {
    agent: AgentConfig.parse(config.agent),
    workspaceId: config.workspaceId as string,
    sessionId: config.sessionId as string,
    routing: RoutingReleaseSnapshot.parse(config.routing),
  };
}

/**
 * The router behaviour (§7.3, §7.5): the worker selects it in place of the router release's own
 * behaviour for segment 0 of a routed call. It needs the host's routing and segment-handoff
 * services; the release's LLM (the `llm` engine), decision slot (the `decision` engine) and event
 * sink are optional, and an engine whose port is absent reports `disabled`.
 */
export function createRouterBehaviorPlugin() {
  return definePlugin(
    {
      id: ROUTER_BEHAVIOR_PLUGIN_ID,
      version: '0.1.0',
      contractVersion: 2,
      kind: 'behavior',
      scope: 'session',
      requires: [Cap.routing, Cap.segmentHandoff],
      optional: [Cap.inference, Cap.decision, Cap.events],
      provides: [Cap.behavior],
      configSchema: routerConfigSchema,
      secretFields: [],
    },
    (ctx, rawConfig) => {
      const config = parseRouterConfig(rawConfig);
      const host = ctx.get(Cap.routing);
      const handoff = ctx.get(Cap.segmentHandoff);
      const inference = ctx.maybe(Cap.inference) as Inference | undefined;
      const decision = ctx.maybe(Cap.decision) as DecisionPort | undefined;
      const events = ctx.maybe(Cap.events) as EventSink | undefined;
      const core = new RouterCore(config.routing, {
        host,
        handoff,
        runners: createEngineRunners({
          host,
          ...(decision ? { decision } : {}),
          ...(inference ? { inference } : {}),
        }),
        ...(events ? { events } : {}),
        timezone: config.agent.timezone,
      });
      const behavior = new RouterBehavior(core);
      ctx.provide(Cap.behavior, behavior);
      ctx.effect(() => () => {
        // swallow-ok: dispose abandons an uncommitted handoff, which is idempotent cleanup.
        void behavior.dispose().catch(() => undefined);
      });
    },
  );
}
