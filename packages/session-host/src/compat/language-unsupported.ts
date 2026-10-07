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
    const byBinding = capabilities?.bindingLanguages;
    const bound = byBinding ? boundLanguages(byBinding, input, choice) : [];
    const where = { slot, pluginId: choice.pluginId } as const;
    const issues =
      supports(capabilities?.languages, language) || bound.includes(baseOf(language))
        ? []
        : [
            issue(
              'language_unsupported',
              stage,
              `${choice.pluginId} does not support ${language}`,
              where,
            ),
          ];
    // N4: every language callers may speak must be transcribed, or their words reach the agent as
    // misheard text in another language rather than being recognised for what they are.
    if (slot !== 'stt') return issues;
    for (const code of input.config.languages?.allowed ?? [])
      if (!supportsBase(capabilities?.languages, code) && !bound.includes(code))
        issues.push(
          issue(
            'language_unsupported',
            stage,
            `${choice.pluginId} does not support ${code}, an allowed language`,
            { ...where, field: 'languages.allowed' },
          ),
        );
    return issues;
  });

function supports(languages: readonly string[] | undefined, language: string): boolean {
  return !languages?.length || languages.includes('*') || languages.includes(language);
}

/** A base code is supported when any listed tag has it: `hi-IN` covers `hi`. */
function supportsBase(languages: readonly string[] | undefined, code: string): boolean {
  return supports(languages, code) || Boolean(languages?.some((tag) => baseOf(tag) === code));
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
