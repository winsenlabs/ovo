import type { SpeechCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatInput, CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';

/**
 * Base language codes per value of one binding field, declared by plugins whose languages depend
 * on the bound model (a multilingual model transcribes hi-IN where the default one does not).
 */
interface BindingLanguages {
  field: string;
  default: string;
  by: Readonly<Record<string, readonly string[]>>;
}

type Capabilities = SpeechCapabilities & { bindingLanguages?: BindingLanguages };
type Choice = ReturnType<typeof resolved>[number]['choice'];

export const languageUnsupported: CompatRule = (input, stage) =>
  resolved(input).flatMap(({ slot, choice, definition }) => {
    if (slot !== 'stt' && slot !== 'tts') return [];
    const capabilities = manifestKeys(definition.manifest).manifest.capabilities as
      Capabilities | undefined;
    const language = input.config.language;
    if (supports(capabilities?.languages, language)) return [];
    const byBinding = capabilities?.bindingLanguages;
    if (byBinding && boundLanguages(byBinding, input, choice).includes(baseOf(language))) return [];
    return [
      issue('language_unsupported', stage, `${choice.pluginId} does not support ${language}`, {
        slot,
        pluginId: choice.pluginId,
      }),
    ];
  });

function supports(languages: readonly string[] | undefined, language: string): boolean {
  return !languages?.length || languages.includes('*') || languages.includes(language);
}

/** The bound model's base codes; the field's declared default when the binding leaves it unset. */
function boundLanguages(
  declared: BindingLanguages,
  input: CompatInput,
  choice: Choice,
): readonly string[] {
  const binding =
    choice.binding ?? (choice.bindingId ? input.bindings?.[choice.bindingId] : undefined);
  const value = binding?.config[declared.field];
  return declared.by[typeof value === 'string' ? value : declared.default] ?? [];
}

function baseOf(language: string): string {
  return language.split('-')[0]!.toLowerCase();
}
