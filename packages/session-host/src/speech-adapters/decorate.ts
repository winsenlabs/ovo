import { Cap, type SpeechToText, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { definePlugin, manifestKeys, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { adaptSpeechToText } from './stt-format.ts';
import { adaptTextToSpeech } from './tts-format.ts';

export type SpeechDecorator = (definition: PluginDefinition) => PluginDefinition;
export type SpeechDecorators = Partial<Record<'stt' | 'tts' | 'llm', SpeechDecorator>>;

/** Apply host telemetry adapters by manifest kind, never by provider name or plugin id. */
export function decorateByKind(
  definition: PluginDefinition,
  decorators: SpeechDecorators,
): PluginDefinition {
  const kind = manifestKeys(definition.manifest).manifest.kind;
  return kind === 'stt' || kind === 'tts' || kind === 'llm'
    ? (decorators[kind]?.(definition) ?? definition)
    : definition;
}

/** Intercept the selected plugin's own provider registration; no second writer is registered. */
export function adaptDefinitionFormats(definition: PluginDefinition): PluginDefinition {
  return decorateByKind(definition, {
    stt: (selected) =>
      wrapProvision(selected, Cap.stt, (value) => adaptSpeechToText(value as SpeechToText)),
    tts: (selected) =>
      wrapProvision(selected, Cap.tts, (value) => adaptTextToSpeech(value as TextToSpeech)),
  });
}

function wrapProvision(
  definition: PluginDefinition,
  key: string,
  adapt: (value: unknown) => unknown,
): PluginDefinition {
  return definePlugin(definition.manifest, (ctx, config) =>
    definition.apply(
      new Proxy(ctx, {
        get(target, property, receiver) {
          if (property !== 'provide') return Reflect.get(target, property, receiver);
          return (name: string, value: unknown) => {
            const provide = target.provide as (key: string, value: unknown) => () => void;
            return provide.call(target, name, name === key ? adapt(value) : value);
          };
        },
      }),
      config,
    ),
  );
}
