import type { CompatRule } from './types.ts';
import { issue, selected } from './types.ts';
export const fixtureUnavailable: CompatRule = (input, stage) =>
  stage === 'test'
    ? selected(input).flatMap(([slot, choice]) =>
        ['carrier', 'stt', 'tts', 'llm'].includes(slot) &&
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
