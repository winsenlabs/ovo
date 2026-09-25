import type { CompatRule } from './types.ts';
import { issue, selected } from './types.ts';
const NEEDS_BINDING = new Set(['carrier', 'stt', 'tts', 'llm']);
export const bindingMissing: CompatRule = (input, stage) =>
  selected(input).flatMap(([slot, choice]) => {
    if (!NEEDS_BINDING.has(slot)) return [];
    if (!choice.bindingId)
      return [
        issue('binding_missing', stage, `${slot} requires a binding`, {
          slot: slot as never,
          pluginId: choice.pluginId,
        }),
      ];
    if (choice.binding || input.bindings?.[choice.bindingId] || choice.bindingId === 'env')
      return [];
    return [
      issue('binding_missing', stage, `Binding ${choice.bindingId} is missing`, {
        slot: slot as never,
        pluginId: choice.pluginId,
      }),
    ];
  });
