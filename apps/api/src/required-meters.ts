import type { AgentConfig, MeterDeclaration, ReleaseSelections } from '@winsendotai/ovo-contracts';
import {
  bindingModel,
  PRICE_UNKNOWN_FOR_MODEL,
  priceCardMatchesModel,
  VENDOR_PRICE_CATALOG,
  type CostLedgerService,
  type PriceCardVersion,
} from '@winsendotai/ovo-plugin-ledger';
import type { ProviderBinding } from '@winsendotai/ovo-plugin-storage';
import { manifestKeys, type PluginRegistry } from '@winsendotai/ovo-runtime';
import { sessionRequiresInput } from '@winsendotai/ovo-session-host/input-policy';

type Slot = 'carrier' | 'stt' | 'tts' | 'llm' | 'decision';

export type RequiredMeterStatus =
  | 'covered'
  /** The cost policy has no price reference for this meter key. */
  | 'missing'
  /** The reference names a price-card version the ledger does not hold. */
  | 'price_card_unavailable'
  /** The card prices a different model than the binding runs (OPS-13). */
  | typeof PRICE_UNKNOWN_FOR_MODEL
  /** The card's provider or unit differs from the meter's; the worker would refuse the usage. */
  | 'unit_mismatch'
  /** A non-INR card without the FX version that converts it. */
  | 'fx_missing';

export interface RequiredMeter {
  key: string;
  unit: string;
  label: string;
  slot: Slot;
  pluginId: string;
  provider?: string;
  /** The model the selected binding runs, when the plugin has one. */
  model?: string;
  status: RequiredMeterStatus;
  reference?: { id: string; version: string; fxId?: string; fxVersion?: string };
  card?: PriceCardVersion;
  /** Catalog entries that price this meter for this model (`POST /v1/cost/price-catalog/import`). */
  catalog: { id: string; version: string; model?: string; provisional: boolean }[];
}

/**
 * OPS-14: the meters a release will emit, each with its price reference and what is wrong with
 * it, so cost setup is a checklist instead of hand-typed meter keys. Mirrors the slots the
 * `meter_uncovered` compat rule requires, including a decision model's meters.
 */
export async function requiredMeterChecklist(input: {
  config: AgentConfig;
  selections: ReleaseSelections;
  registry: PluginRegistry;
  bindings?: Readonly<Record<string, ProviderBinding>>;
  ledger?: Pick<CostLedgerService, 'getPriceCard'>;
}): Promise<{ complete: boolean; provisional: boolean; meters: RequiredMeter[] }> {
  const { config, selections, registry } = input;
  const slots: Slot[] = [
    'carrier',
    ...(sessionRequiresInput(config) ? ['stt' as const] : []),
    'tts',
    ...(['context', 'agent'].includes(config.mode) ? ['llm' as const] : []),
    ...(config.decision?.enabled ? ['decision' as const] : []),
  ];
  const priceCards = config.costPolicy?.priceCards ?? {};
  const meters: RequiredMeter[] = [];
  for (const slot of slots) {
    const choice = selections[slot];
    if (!choice) continue;
    const manifest = manifestKeys(
      registry.resolvePin(choice.pluginId, choice.version).definition.manifest,
    ).manifest;
    const binding =
      choice.binding?.config ??
      (choice.bindingId ? input.bindings?.[choice.bindingId]?.config : undefined) ??
      {};
    const model = bindingModel(binding, manifest.bindingSchema);
    const declared = (manifest.meters ?? []).filter(
      (meter: MeterDeclaration) =>
        meter.role === slot &&
        (!meter.when || meter.when.in.includes(String(binding[meter.when.field] ?? ''))),
    );
    for (const meter of declared) {
      const reference = priceCards[meter.key];
      const card = reference
        ? await input.ledger?.getPriceCard(reference.id, reference.version)
        : undefined;
      meters.push({
        key: meter.key,
        unit: meter.unit,
        label: meter.label,
        slot,
        pluginId: manifest.id,
        ...(manifest.provider ? { provider: manifest.provider } : {}),
        ...(model ? { model } : {}),
        status: status(meter, manifest.provider, reference, card, model, Boolean(input.ledger)),
        ...(reference ? { reference } : {}),
        ...(card ? { card } : {}),
        catalog: VENDOR_PRICE_CATALOG.filter(
          (entry) =>
            entry.meterKeys.includes(meter.key) && priceCardMatchesModel(entry.card, model),
        ).map(({ card: entry }) => ({
          id: entry.id,
          version: entry.version,
          ...(entry.model ? { model: entry.model } : {}),
          provisional: entry.provisional === true,
        })),
      });
    }
  }
  return {
    complete: meters.every((meter) => meter.status === 'covered'),
    provisional: meters.some((meter) => meter.card?.provisional === true),
    meters,
  };
}

function status(
  meter: MeterDeclaration,
  provider: string | undefined,
  reference: RequiredMeter['reference'],
  card: PriceCardVersion | undefined,
  model: string | undefined,
  ledgerAvailable: boolean,
): RequiredMeterStatus {
  if (!reference) return 'missing';
  // Without a ledger the reference cannot be checked further; admission still checks it.
  if (!ledgerAvailable) return 'covered';
  if (!card) return 'price_card_unavailable';
  if (card.unit !== meter.unit || (provider !== undefined && card.provider !== provider))
    return 'unit_mismatch';
  if (!priceCardMatchesModel(card, model)) return PRICE_UNKNOWN_FOR_MODEL;
  if (card.currency !== 'INR' && (!reference.fxId || !reference.fxVersion)) return 'fx_missing';
  return 'covered';
}
