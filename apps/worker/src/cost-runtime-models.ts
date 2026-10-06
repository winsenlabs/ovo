import { LIVE_COST_METER_KEYS } from '@winsendotai/ovo-plugin-kit';
import {
  bindingModel,
  priceCardMatchesModel,
  type CostLedgerService,
  type PriceCardVersion,
} from '@winsendotai/ovo-plugin-ledger';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { ReleaseSelections } from '@winsendotai/ovo-contracts';
import { manifestKeys, type PluginRegistry } from '@winsendotai/ovo-runtime';
import type { SelectedMeter } from '@winsendotai/ovo-session-host';
import type { CostPolicy } from './cost-policy-types.ts';

/**
 * The model each required meter is billed for: the selected binding's `model`, else its schema
 * default. A meter whose plugin names no model is absent, and any card prices it.
 */
export function requiredMeterModels(
  release: Pick<ReleaseRecord, 'providerBindings'>,
  requiredMeterKeys: readonly string[],
  selected?: {
    meters: readonly SelectedMeter[];
    selections: ReleaseSelections;
    registry: PluginRegistry;
  },
): Map<string, string> {
  const models = new Map<string, string>();
  if (selected?.meters.length) {
    for (const row of selected.meters) {
      const selection = selected.selections[row.slot];
      if (!selection) continue;
      const manifest = manifestKeys(
        selected.registry.resolvePin(selection.pluginId, selection.version).definition.manifest,
      ).manifest;
      const model = bindingModel(selection.binding?.config, manifest.bindingSchema);
      if (model) models.set(row.meter.key, model);
    }
    return models;
  }
  // Legacy releases without a registry: only the LLM binding names its model.
  const inference = release.providerBindings.inference?.config.model;
  if (typeof inference !== 'string' || !inference.trim()) return models;
  const keys = LIVE_COST_METER_KEYS.inference;
  for (const key of [
    keys.aggregateInput,
    keys.uncachedInput,
    keys.cacheReadInput,
    keys.cacheWriteInput,
    keys.output,
  ])
    if (requiredMeterKeys.includes(key)) models.set(key, inference.trim());
  return models;
}

/**
 * OPS-13 at admission: required meters whose price card names a different model than the binding
 * runs. Meter keys carry no model, so without this a model swap is silently billed at the old
 * model's price. A card the ledger does not hold is left to the catalog load, which refuses it.
 * `cards` keeps what was read, so the catalog load does not read the same cards again.
 */
export async function meterKeysPricedForAnotherModel(
  ledger: Pick<CostLedgerService, 'getPriceCard'>,
  policy: CostPolicy,
  models: ReadonlyMap<string, string>,
  cards: Map<string, PriceCardVersion | undefined>,
): Promise<string[]> {
  const mismatched: string[] = [];
  for (const [meterKey, model] of models) {
    const reference = policy.priceCards[meterKey];
    if (!reference) continue;
    const card = await ledger.getPriceCard(reference.id, reference.version);
    cards.set(meterKey, card);
    if (card && !priceCardMatchesModel(card, model)) mismatched.push(meterKey);
  }
  return mismatched.sort();
}

/** The model check as an admission verdict, with the cards it read for the catalog load. */
export async function checkMeterModels(
  ledger: Pick<CostLedgerService, 'getPriceCard'>,
  policy: CostPolicy,
  models: ReadonlyMap<string, string>,
): Promise<{ refusal?: string; cards: Map<string, PriceCardVersion | undefined> }> {
  const cards = new Map<string, PriceCardVersion | undefined>();
  const repriced = await meterKeysPricedForAnotherModel(ledger, policy, models, cards);
  return repriced.length
    ? { refusal: `price_unknown_for_model:${repriced.join(',')}`, cards }
    : { cards };
}
