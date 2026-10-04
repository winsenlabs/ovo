import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
import { sessionRequiresInput } from '../input-policy.ts';
export const meterUncovered: CompatRule = (input, stage) => {
  const entries = resolved(input);
  const required: readonly ('carrier' | 'stt' | 'tts' | 'llm')[] = [
    'carrier',
    ...(sessionRequiresInput(input.config) ? ['stt' as const] : []),
    'tts',
    ...(['context', 'agent'].includes(input.config.mode) ? ['llm' as const] : []),
  ];
  const missingRoles = required
    .filter((slot) => !entries.some((entry) => entry.slot === slot))
    .map((slot) =>
      issue(
        'meter_uncovered',
        stage,
        `No selected ${slot} plugin can be checked for meter coverage`,
        { slot, field: slot },
        stage === 'test' ? 'warning' : 'error',
      ),
    );
  return [
    ...missingRoles,
    ...entries.flatMap(({ slot, choice, definition }) => {
      if (!required.includes(slot as (typeof required)[number])) return [];
      const binding =
        choice.binding?.config ??
        (choice.bindingId ? input.bindings?.[choice.bindingId]?.config : undefined) ??
        {};
      const meters = (manifestKeys(definition.manifest).manifest.meters ?? []).filter(
        (meter) =>
          meter.role === slot &&
          (!meter.when || meter.when.in.includes(String(binding[meter.when.field] ?? ''))),
      );
      const missing = meters.length
        ? meters.filter((meter) => !input.priceCards?.[meter.key]).map((meter) => meter.key)
        : [slot];
      return missing.map((key) =>
        issue(
          'meter_uncovered',
          stage,
          `No price card covers ${key}`,
          { slot: slot as never, pluginId: choice.pluginId, field: key },
          stage === 'test' ? 'warning' : 'error',
        ),
      );
    }),
  ];
};
