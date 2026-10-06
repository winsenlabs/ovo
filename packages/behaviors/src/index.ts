import {
  Cap,
  type DecisionPort,
  type EventSink,
  type Execution,
  type KnowledgePort,
  type Inference,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { createAgentBehavior } from './agent.ts';
import { createAnnouncementBehavior } from './announcement.ts';
import { createContextBehavior } from './context.ts';
import { createFaqBehavior } from './faq.ts';
import { ExecutingFaqBehavior } from './faq-execution.ts';
import { withScript } from './script.ts';
import { behaviorConfigSchema, parsePluginConfig, requireMode } from './plugin-config.ts';

export type { BehaviorPluginConfig } from './plugin-config.ts';

export * from './agent.ts';
export * from './announcement.ts';
export * from './context.ts';
export * from './agent-confirmation-step.ts';
export * from './agent-ending.ts';
export * from './agent-variables.ts';
export * from './agent-turn-log.ts';
export * from './agent-decision-step.ts';
export * from './agent-pre-reply.ts';
export * from './decision-gate.ts';
export * from './grounding.ts';
export * from './grounding-step.ts';
export * from './faq.ts';
export * from './faq-execution.ts';
export * from './script.ts';
export * from './text-segmenter.ts';
export * from './guardrail.ts';
export * from './outcome-events.ts';

/** The capability keys a behaviour plugin touches. Spelled once, in contracts (§0.3). */
export const BEHAVIOR_SERVICE_KEYS = Object.freeze({
  behavior: Cap.behavior,
  inference: Cap.inference,
  execution: Cap.execution,
  decision: Cap.decision,
  knowledge: Cap.knowledge,
  events: Cap.events,
});

export const BEHAVIOR_PLUGIN_IDS = Object.freeze({
  announcement: '@winsendotai/ovo-behavior-announcement',
  faq: '@winsendotai/ovo-behavior-faq',
  faqTools: '@winsendotai/ovo-behavior-faq-tools',
  context: '@winsendotai/ovo-behavior-context',
  agent: '@winsendotai/ovo-behavior-agent',
});

/**
 * A script (announcement or FAQ mode) may ask the selected decision plugin to match replies to its
 * transitions (AGT-14). Reading an optional capability needs a v2 manifest, whose migration adds
 * the kind and nothing else, exactly as the agent plugin's did.
 */
const scriptDecision = {
  contractVersion: 2,
  kind: 'behavior',
  optional: [BEHAVIOR_SERVICE_KEYS.decision],
} as const;

export function createAnnouncementBehaviorPlugin() {
  return definePlugin(
    {
      id: BEHAVIOR_PLUGIN_IDS.announcement,
      version: '0.1.0',
      ...scriptDecision,
      scope: 'session',
      requires: [],
      provides: [BEHAVIOR_SERVICE_KEYS.behavior],
      configSchema: behaviorConfigSchema,
      secretFields: [],
    },
    (ctx, rawConfig) => {
      const config = parsePluginConfig(rawConfig);
      ctx.provide(
        BEHAVIOR_SERVICE_KEYS.behavior,
        withScript(
          config.agent,
          createAnnouncementBehavior(requireMode(config.agent, 'announcement')),
          ctx.maybe(BEHAVIOR_SERVICE_KEYS.decision) as DecisionPort | undefined,
        ),
      );
    },
  );
}

export function createFaqBehaviorPlugin() {
  return definePlugin(
    {
      id: BEHAVIOR_PLUGIN_IDS.faq,
      version: '0.1.0',
      ...scriptDecision,
      scope: 'session',
      requires: [],
      provides: [BEHAVIOR_SERVICE_KEYS.behavior],
      configSchema: behaviorConfigSchema,
      secretFields: [],
    },
    (ctx, rawConfig) => {
      const config = parsePluginConfig(rawConfig);
      ctx.provide(
        BEHAVIOR_SERVICE_KEYS.behavior,
        withScript(
          config.agent,
          createFaqBehavior(requireMode(config.agent, 'faq')),
          ctx.maybe(BEHAVIOR_SERVICE_KEYS.decision) as DecisionPort | undefined,
        ),
      );
    },
  );
}

export function createFaqExecutionBehaviorPlugin() {
  return definePlugin(
    {
      id: BEHAVIOR_PLUGIN_IDS.faqTools,
      version: '0.1.0',
      ...scriptDecision,
      scope: 'session',
      requires: [BEHAVIOR_SERVICE_KEYS.execution],
      provides: [BEHAVIOR_SERVICE_KEYS.behavior],
      configSchema: { ...behaviorConfigSchema, required: ['agent', 'workspaceId', 'sessionId'] },
      secretFields: [],
    },
    (ctx, rawConfig) => {
      const config = parsePluginConfig(rawConfig);
      if (!config.workspaceId || !config.sessionId)
        throw new Error('FAQ tools require session identity');
      const execution = ctx.get(BEHAVIOR_SERVICE_KEYS.execution) as Execution | undefined;
      if (!execution) throw new Error('Missing FAQ execution service');
      const behavior = new ExecutingFaqBehavior(requireMode(config.agent, 'faq'), execution, {
        workspaceId: config.workspaceId,
        sessionId: config.sessionId,
      });
      ctx.provide(
        BEHAVIOR_SERVICE_KEYS.behavior,
        withScript(
          config.agent,
          behavior,
          ctx.maybe(BEHAVIOR_SERVICE_KEYS.decision) as DecisionPort | undefined,
        ),
      );
      ctx.effect(() => () => behavior.cancel());
    },
  );
}

export function createContextBehaviorPlugin() {
  return definePlugin(
    {
      id: BEHAVIOR_PLUGIN_IDS.context,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [BEHAVIOR_SERVICE_KEYS.inference],
      provides: [BEHAVIOR_SERVICE_KEYS.behavior],
      configSchema: behaviorConfigSchema,
      secretFields: [],
    },
    (ctx, rawConfig) => {
      const config = parsePluginConfig(rawConfig);
      const inference = ctx.get(BEHAVIOR_SERVICE_KEYS.inference) as Inference | undefined;
      if (!inference) throw new Error(`Missing ${BEHAVIOR_SERVICE_KEYS.inference}`);
      const behavior = createContextBehavior(requireMode(config.agent, 'context'), inference);
      ctx.provide(BEHAVIOR_SERVICE_KEYS.behavior, behavior);
      ctx.effect(() => () => behavior.cancel());
    },
  );
}

export function createAgentBehaviorPlugin() {
  return definePlugin(
    {
      id: BEHAVIOR_PLUGIN_IDS.agent,
      version: '0.1.0',
      // v2, alone among the behaviour plugins, because only this one reads an optional capability:
      // a v1 manifest has no `optional`, and reading an undeclared key is a recorded violation
      // (`read-undeclared`, runtime/src/facade.ts). `behavior` declares no provider, capabilities,
      // runtime or conformance, so the migration adds the kind and nothing else.
      contractVersion: 2,
      kind: 'behavior',
      scope: 'session',
      requires: [BEHAVIOR_SERVICE_KEYS.execution],
      // Optional so an agent with no decision policy composes as before, and a Jev-only agent
      // (AGT-4) with no LLM at all: it answers a turn that would need one with its re-ask line.
      optional: [
        BEHAVIOR_SERVICE_KEYS.inference,
        BEHAVIOR_SERVICE_KEYS.decision,
        BEHAVIOR_SERVICE_KEYS.knowledge,
        BEHAVIOR_SERVICE_KEYS.events,
      ],
      provides: [BEHAVIOR_SERVICE_KEYS.behavior],
      configSchema: {
        ...behaviorConfigSchema,
        required: ['agent', 'workspaceId', 'sessionId'],
      },
      secretFields: [],
    },
    (ctx, rawConfig) => {
      const config = parsePluginConfig(rawConfig);
      if (!config.workspaceId || !config.sessionId)
        throw new TypeError('Agent plugin requires workspaceId and sessionId');
      // On a v2 manifest `get` throws for a missing required key; `maybe` is the optional read.
      const inference = ctx.maybe(BEHAVIOR_SERVICE_KEYS.inference) as Inference | undefined;
      const execution = ctx.get(BEHAVIOR_SERVICE_KEYS.execution) as Execution;
      const decision = ctx.maybe(BEHAVIOR_SERVICE_KEYS.decision) as DecisionPort | undefined;
      const knowledge = ctx.maybe(BEHAVIOR_SERVICE_KEYS.knowledge) as KnowledgePort | undefined;
      const events = ctx.maybe(BEHAVIOR_SERVICE_KEYS.events) as EventSink | undefined;
      // A policy without a plugin is a release-validation error (`decision_plugin_missing`); fail
      // here too, so a graph assembled by any other path cannot silently run an unjudged call.
      if (config.agent.decision?.enabled && !decision)
        throw new Error(
          `Agent ${config.agent.name} configures a decision policy, but no ${BEHAVIOR_SERVICE_KEYS.decision} plugin is selected`,
        );
      if (config.agent.knowledge?.enabled && !knowledge)
        throw new Error(
          `Agent ${config.agent.name} configures a knowledge policy, but no ${BEHAVIOR_SERVICE_KEYS.knowledge} plugin is selected`,
        );
      const behavior = createAgentBehavior(
        requireMode(config.agent, 'agent'),
        inference,
        execution,
        {
          workspaceId: config.workspaceId,
          sessionId: config.sessionId,
          ...(decision ? { decision } : {}),
          ...(knowledge ? { knowledge } : {}),
          ...(events ? { events } : {}),
        },
      );
      ctx.provide(BEHAVIOR_SERVICE_KEYS.behavior, behavior);
      ctx.effect(() => () => behavior.cancel());
    },
  );
}

/** Catalog-ready first-party definitions; select exactly one per session. */
export function createBehaviorPluginCatalog() {
  return [
    createAnnouncementBehaviorPlugin(),
    createFaqBehaviorPlugin(),
    createFaqExecutionBehaviorPlugin(),
    createContextBehaviorPlugin(),
    createAgentBehaviorPlugin(),
  ] as const;
}
