import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, selected } from './types.ts';
export const bindingPluginMismatch: CompatRule = (input, stage) =>
  selected(input).flatMap(([slot, choice]) => {
    const binding =
      choice.binding ?? (choice.bindingId ? input.bindings?.[choice.bindingId] : undefined);
    if (!binding) return [];
    const manifest = input.registry.get(choice.pluginId);
    if (!manifest) return [];
    const provider = manifestKeys(manifest.manifest).manifest.provider;
    const wrong =
      ('pluginId' in binding && binding.pluginId && binding.pluginId !== choice.pluginId) ||
      (provider && binding.provider && binding.provider !== provider);
    return wrong
      ? [
          issue('binding_plugin_mismatch', stage, `Binding does not match ${choice.pluginId}`, {
            slot: slot as never,
            pluginId: choice.pluginId,
          }),
        ]
      : [];
  });
