import type { AgentConfig, ReleaseSelection } from '@winsendotai/ovo-contracts';

/** The turn detector whose config schema reads `languages` (plugin-turns). */
const DEFAULT_TURN_DETECTOR = '@winsendotai/ovo-turn-detector-default';

/**
 * N4: the turn detector row's config, with the agent's allowed languages added for the default
 * detector, which then holds back barge-ins on words outside them. Any other detector's config is
 * left exactly as authored: its schema may not accept the field.
 */
export function turnDetectorConfig(
  selection: Pick<ReleaseSelection, 'pluginId' | 'config'>,
  config: Pick<AgentConfig, 'languages'>,
): Record<string, unknown> {
  return config.languages && selection.pluginId === DEFAULT_TURN_DETECTOR
    ? { ...selection.config, languages: config.languages.allowed }
    : selection.config;
}
