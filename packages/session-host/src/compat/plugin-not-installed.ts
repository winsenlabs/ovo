import type { CompatRule } from './types.ts';
import { issue, selected } from './types.ts';
export const pluginNotInstalled: CompatRule = (input, stage) =>
  selected(input).flatMap(([slot, choice]) =>
    input.registry.get(choice.pluginId)
      ? []
      : [
          issue('plugin_not_installed', stage, `${choice.pluginId} is not installed`, {
            slot: slot as never,
            pluginId: choice.pluginId,
          }),
        ],
  );
