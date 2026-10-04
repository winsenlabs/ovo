import type { PluginRow } from '@winsendotai/ovo-runtime';

export type DeploymentProfile = 'compose' | 'fargate';
export type Environment = Readonly<Record<string, string | undefined>>;
export type ProfileRows = (profile: DeploymentProfile, env: Environment) => PluginRow[];
