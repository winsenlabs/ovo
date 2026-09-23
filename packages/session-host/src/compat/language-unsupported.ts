import type { SpeechCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const languageUnsupported: CompatRule = (input, stage) =>
  resolved(input).flatMap(({ slot, choice, definition }) => {
    if (slot !== 'stt' && slot !== 'tts') return [];
    const languages = (
      manifestKeys(definition.manifest).manifest.capabilities as SpeechCapabilities | undefined
    )?.languages;
    if (!languages?.length || languages.includes('*') || languages.includes(input.config.language))
      return [];
    return [
      issue(
        'language_unsupported',
        stage,
        `${choice.pluginId} does not support ${input.config.language}`,
        { slot, pluginId: choice.pluginId },
      ),
    ];
  });
