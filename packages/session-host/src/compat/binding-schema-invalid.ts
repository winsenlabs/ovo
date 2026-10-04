import { PluginRegistry } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, selected } from './types.ts';
export const bindingSchemaInvalid: CompatRule = (input, stage) =>
  selected(input).flatMap(([slot, choice]) => {
    const binding =
      choice.binding ?? (choice.bindingId ? input.bindings?.[choice.bindingId] : undefined);
    if (!binding || !input.registry.get(choice.pluginId)) return [];
    let definition;
    try {
      definition = input.registry.resolvePin(choice.pluginId, choice.version).definition;
    } catch {
      return [];
    }
    const result = new PluginRegistry([definition]).validateBinding(
      choice.pluginId,
      binding.config,
    );
    return result.ok
      ? []
      : [
          issue('binding_schema_invalid', stage, result.errors, {
            slot: slot as never,
            pluginId: choice.pluginId,
          }),
        ];
  });
