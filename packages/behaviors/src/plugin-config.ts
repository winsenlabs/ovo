import { AgentConfig as AgentConfigSchema, type AgentConfig } from '@winsendotai/ovo-contracts';

/** What every first-party behaviour plugin is configured with. */
export interface BehaviorPluginConfig {
  agent: AgentConfig;
  workspaceId?: string;
  sessionId?: string;
}

export const behaviorConfigSchema = {
  type: 'object',
  required: ['agent'],
  properties: {
    agent: { type: 'object' },
    workspaceId: { type: 'string', minLength: 1 },
    sessionId: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

export function parsePluginConfig(config: Record<string, unknown>): BehaviorPluginConfig {
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

export function requireMode(config: AgentConfig, mode: AgentConfig['mode']): AgentConfig {
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
