import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Execution,
  type Inference,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { createAgentBehavior } from './agent.ts';
import { createAnnouncementBehavior } from './announcement.ts';
import { createContextBehavior } from './context.ts';
import { createFaqBehavior } from './faq.ts';
import { ExecutingFaqBehavior } from './faq-execution.ts';
import { withScript } from './script.ts';

export * from './agent.ts';
export * from './announcement.ts';
export * from './context.ts';
export * from './faq.ts';
export * from './faq-execution.ts';
export * from './script.ts';
export * from './text-segmenter.ts';

export const BEHAVIOR_SERVICE_KEYS = Object.freeze({
  behavior: 'ovo.behavior',
  inference: 'ovo.inference',
  execution: 'ovo.execution',
});

export const BEHAVIOR_PLUGIN_IDS = Object.freeze({
  announcement: '@winsendotai/ovo-behavior-announcement',
  faq: '@winsendotai/ovo-behavior-faq',
  faqTools: '@winsendotai/ovo-behavior-faq-tools',
  context: '@winsendotai/ovo-behavior-context',
  agent: '@winsendotai/ovo-behavior-agent',
});

export interface BehaviorPluginConfig {
  agent: AgentConfig;
  workspaceId?: string;
  sessionId?: string;
}

const behaviorConfigSchema = {
  type: 'object',
  required: ['agent'],
  properties: {
    agent: { type: 'object' },
    workspaceId: { type: 'string', minLength: 1 },
    sessionId: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

export function createAnnouncementBehaviorPlugin() {
  return definePlugin(
    {
      id: BEHAVIOR_PLUGIN_IDS.announcement,
      version: '0.1.0',
      contractVersion: 1,
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
      contractVersion: 1,
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
        withScript(config.agent, createFaqBehavior(requireMode(config.agent, 'faq'))),
      );
    },
  );
}

export function createFaqExecutionBehaviorPlugin() {
  return definePlugin(
    {
      id: BEHAVIOR_PLUGIN_IDS.faqTools,
      version: '0.1.0',
      contractVersion: 1,
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
      ctx.provide(BEHAVIOR_SERVICE_KEYS.behavior, withScript(config.agent, behavior));
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
      contractVersion: 1,
      scope: 'session',
      requires: [BEHAVIOR_SERVICE_KEYS.inference, BEHAVIOR_SERVICE_KEYS.execution],
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
      const inference = ctx.get(BEHAVIOR_SERVICE_KEYS.inference) as Inference | undefined;
      const execution = ctx.get(BEHAVIOR_SERVICE_KEYS.execution) as Execution | undefined;
      if (!inference) throw new Error(`Missing ${BEHAVIOR_SERVICE_KEYS.inference}`);
      if (!execution) throw new Error(`Missing ${BEHAVIOR_SERVICE_KEYS.execution}`);
      const behavior = createAgentBehavior(
        requireMode(config.agent, 'agent'),
        inference,
        execution,
        {
          workspaceId: config.workspaceId,
          sessionId: config.sessionId,
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

function parsePluginConfig(config: Record<string, unknown>): BehaviorPluginConfig {
  const unknown = Object.keys(config).find(
    (key) => !['agent', 'workspaceId', 'sessionId'].includes(key),
  );
  if (unknown) throw new TypeError(`Unknown behavior plugin config field: ${unknown}`);
  if (typeof config.agent !== 'object' || config.agent === null)
    throw new TypeError('Behavior plugin requires agent config');
  return {
    agent: AgentConfigSchema.parse(config.agent),
    workspaceId: optionalString(config.workspaceId, 'workspaceId'),
    sessionId: optionalString(config.sessionId, 'sessionId'),
  };
}

function requireMode(config: AgentConfig, mode: AgentConfig['mode']): AgentConfig {
  if (config.mode !== mode)
    throw new TypeError(`Plugin requires ${mode} mode, received ${config.mode}`);
  return config;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    throw new TypeError(`${name} must be a non-empty string`);
  return value;
}
