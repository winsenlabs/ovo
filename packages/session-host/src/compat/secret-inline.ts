import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, selected } from './types.ts';
function pointer(value: unknown, path: string): unknown {
  return path
    .split('/')
    .slice(1)
    .reduce<unknown>(
      (part, token) =>
        part && typeof part === 'object'
          ? (part as Record<string, unknown>)[token.replaceAll('~1', '/').replaceAll('~0', '~')]
          : undefined,
      value,
    );
}
export const secretInline: CompatRule = (input, stage) =>
  selected(input).flatMap(([slot, choice]) => {
    const definition = input.registry.get(choice.pluginId);
    if (!definition) return [];
    const binding =
      choice.binding ?? (choice.bindingId ? input.bindings?.[choice.bindingId] : undefined);
    const value = {
      ...(binding
        ? {
            binding: binding.config,
            ...('credentialId' in binding
              ? { credentialRef: { credentialId: binding.credentialId } }
              : {}),
          }
        : {}),
      ...choice.config,
    };
    return manifestKeys(definition.manifest).manifest.secretFields.flatMap((path) => {
      const secret = pointer(value, path);
      return secret === undefined ||
        (secret && typeof secret === 'object' && 'credentialRef' in secret)
        ? []
        : [
            issue('secret_inline', stage, `Secret at ${path} must use credentialRef`, {
              slot: slot as never,
              pluginId: choice.pluginId,
              field: path,
            }),
          ];
    });
  });
