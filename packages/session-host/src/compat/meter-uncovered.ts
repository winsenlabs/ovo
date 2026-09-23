import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const meterUncovered: CompatRule = (input, stage) =>
  resolved(input).flatMap(({ slot, choice, definition }) => {
    if (
      !['carrier', 'stt', 'tts', 'llm'].includes(slot) ||
      (slot === 'stt' && input.config.mode === 'announcement')
    )
      return [];
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
  });
