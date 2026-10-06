import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';

/**
 * An agent setting the selected engine declares it does not honour, as its manifest lists them
 * (`capabilities.unsupportedAgentFeatures`): the config path, how serious ignoring it is, and why.
 * A path counts as used when it holds anything other than `undefined`, `false` or `null`.
 */
export interface UnsupportedAgentFeature {
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

export const engineFeatureUnsupported: CompatRule = (input, stage) => {
  const engine = resolved(input).find((entry) => entry.slot === 'engine');
  if (!engine) return [];
  const capabilities = manifestKeys(engine.definition.manifest).manifest.capabilities as
    { unsupportedAgentFeatures?: readonly UnsupportedAgentFeature[] } | undefined;
  return (capabilities?.unsupportedAgentFeatures ?? [])
    .filter((feature) => used(input.config, feature.path))
    .map((feature) =>
      issue(
        'engine_capability_missing',
        stage,
        feature.message,
        { slot: 'engine', pluginId: engine.choice.pluginId, field: feature.path },
        feature.severity,
      ),
    );
};

function used(config: unknown, path: string): boolean {
  let value: unknown = config;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object') return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value !== undefined && value !== null && value !== false;
}
