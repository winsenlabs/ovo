import type { AgentConfig, ReleaseSelection } from '@winsendotai/ovo-contracts';

/** The turn detectors whose config schema reads `languages` (plugin-turns: the rules, and a model over them). */
const LANGUAGE_AWARE_DETECTORS = new Set([
  '@winsendotai/ovo-turn-detector-default',
  '@winsendotai/ovo-turn-detector-smart-turn',
]);

/**
 * N4: the turn detector row's config, with the agent's allowed languages added for the default
 * detector, which then holds back barge-ins on words outside them. Any other detector's config is
 * left exactly as authored: its schema may not accept the field.
 */
export function turnDetectorConfig(
  selection: Pick<ReleaseSelection, 'pluginId' | 'config'>,
  config: Pick<AgentConfig, 'languages'>,
): Record<string, unknown> {
  return config.languages && LANGUAGE_AWARE_DETECTORS.has(selection.pluginId)
    ? { ...selection.config, languages: config.languages.allowed }
    : selection.config;
}
