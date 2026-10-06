import type { PriceCardVersion } from './types.ts';

/** Readiness code for a price card that names a different model than the binding runs (OPS-13). */
export const PRICE_UNKNOWN_FOR_MODEL = 'price_unknown_for_model';

/**
 * Meter keys are `${provider}.${operation}.${unit}`, so swapping gpt-4o-mini for gpt-6-luna kept
 * the same key and was silently priced at the old model's rate. A card that names its model only
 * prices that model; a card without one is the wildcard and prices any model.
 */
export function priceCardMatchesModel(
  card: Pick<PriceCardVersion, 'model'>,
  model: string | undefined,
): boolean {
  if (!card.model) return true;
  return model !== undefined && normalizeModel(card.model) === normalizeModel(model);
}

/**
 * The model a binding selects: its `model` field (every speech and LLM plugin names it so), else
 * the default its binding schema declares, which is what the plugin runs when the field is unset.
 */
export function bindingModel(
  config: Readonly<Record<string, unknown>> | undefined,
  bindingSchema?: unknown,
): string | undefined {
  const value = config?.model;
  if (typeof value === 'string' && value.trim()) return value.trim();
  const fallback = (bindingSchema as { properties?: { model?: { default?: unknown } } } | undefined)
    ?.properties?.model?.default;
  return typeof fallback === 'string' && fallback.trim() ? fallback.trim() : undefined;
}

const normalizeModel = (model: string) => model.trim().toLowerCase();
