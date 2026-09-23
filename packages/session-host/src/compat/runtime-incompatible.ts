import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, selected } from './types.ts';
export const runtimeIncompatible: CompatRule = (input, stage) =>
  selected(input).flatMap(([slot, choice]) => {
    const definition = input.registry.get(choice.pluginId);
    return definition &&
      manifestKeys(definition.manifest).manifest.runtime?.native === 'glibc' &&
      input.glibc === false
      ? [
          issue('runtime_incompatible', stage, `${choice.pluginId} requires glibc`, {
            slot: slot as never,
            pluginId: choice.pluginId,
          }),
        ]
      : [];
  });
