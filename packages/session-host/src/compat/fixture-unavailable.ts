import type { CompatRule } from './types.ts';
import { issue, selected } from './types.ts';

/**
 * A provider slot a fixture call cannot script. A plugin with no wire of its own still has to be
 * listed — with an empty script — so "this plugin touches nothing" is a published claim rather than
 * an absence the rule has to guess at.
 */
export const fixtureUnavailable: CompatRule = (input, stage) =>
  stage === 'test'
    ? selected(input).flatMap(([slot, choice]) =>
        ['carrier', 'stt', 'tts', 'llm', 'decision', 'knowledge'].includes(slot) &&
        !input.fixturePluginIds?.includes(choice.pluginId) &&
        !input.fixtureTemplatePluginIds?.includes(choice.pluginId)
          ? [
              issue(
                'fixture_unavailable',
                stage,
                `No fixture is available for ${choice.pluginId}`,
                { slot: slot as never, pluginId: choice.pluginId },
              ),
            ]
          : [],
      )
    : [];
