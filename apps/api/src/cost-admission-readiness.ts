import type { AgentConfig, CompatIssue, ReleaseSelections } from '@winsendotai/ovo-contracts';
import {
  bindingModel,
  priceCardMatchesModel,
  type CostLedgerService,
  type PriceCardVersion,
} from '@winsendotai/ovo-plugin-ledger';
import { manifestKeys, type PluginRegistry } from '@winsendotai/ovo-runtime';
import { metersFor } from '@winsendotai/ovo-session-host';
import { sessionRequiresInput } from '@winsendotai/ovo-session-host/input-policy';

const unreadable: unique symbol = Symbol('unreadable');

export type CostAdmissionLedger = Pick<CostLedgerService, 'getPriceCard' | 'getFxVersion'>;

/**
 * The cost checks live admission runs before it takes a call (worker cost-runtime `reserve` and
 * `loadCostCatalog`), run against the ledger so readiness cannot say `liveReady` while the worker
 * refuses every call. Two such outages on 2026-10-07: "Cost meter requires immutable FX" for the
 * carrier meter (a USD card referenced without its FX version) and "Cost price version is
 * unavailable" for the LLM web-search meter (a card version the ledger did not hold). Each
 * message starts with the refusal the worker logs. Without a ledger nothing can be checked here,
 * and admission still refuses. A failed ledger read names the reference it could not read rather
 * than failing the whole readiness answer.
 */
export async function costAdmissionIssues(input: {
  config: AgentConfig;
  selections: ReleaseSelections;
  registry: PluginRegistry;
  ledger?: CostAdmissionLedger;
}): Promise<CompatIssue[]> {
  const policy = input.config.costPolicy;
  if (!policy || !input.ledger) return [];
  const ledger = input.ledger;
  const issues: CompatIssue[] = [];
  const add = (message: string, field: string) =>
    issues.push({ code: 'meter_uncovered', severity: 'error', stage: 'live', message, field });
  const cards = new Map<string, PriceCardVersion | undefined>();
  // The worker loads every referenced card, required or not, and refuses on any bad one.
  for (const [meterKey, reference] of Object.entries(policy.priceCards)) {
    const card = await ledger
      .getPriceCard(reference.id, reference.version)
      .catch((): typeof unreadable => unreadable);
    if (card === unreadable) {
      add(
        `Cost ledger could not be read: ${meterKey} (price card ${reference.id} version ${reference.version})`,
        meterKey,
      );
      continue;
    }
    cards.set(meterKey, card);
    if (!card) {
      add(
        `Cost price version is unavailable: ${meterKey} (price card ${reference.id} version ${reference.version} is not in the ledger; import it or fix the reference)`,
        meterKey,
      );
      continue;
    }
    const hasFxId = reference.fxId !== undefined;
    if (hasFxId !== (reference.fxVersion !== undefined)) {
      add(`Cost FX reference is incomplete: ${meterKey} (set both fxId and fxVersion)`, meterKey);
      continue;
    }
    if (card.currency === 'INR') {
      if (hasFxId)
        add(
          `INR cost meter must not include FX: ${meterKey} (remove fxId and fxVersion)`,
          meterKey,
        );
      continue;
    }
    if (!reference.fxId || !reference.fxVersion) {
      add(
        `Cost meter requires immutable FX: ${meterKey} (the ${card.currency} price card needs fxId and fxVersion of a ${card.currency}-INR FX version)`,
        meterKey,
      );
      continue;
    }
    const fx = await ledger
      .getFxVersion(reference.fxId, reference.fxVersion)
      .catch((): typeof unreadable => unreadable);
    if (fx === unreadable) {
      add(
        `Cost ledger could not be read: ${meterKey} (FX ${reference.fxId} version ${reference.fxVersion})`,
        meterKey,
      );
      continue;
    }
    if (!fx || fx.baseCurrency !== card.currency || fx.quoteCurrency !== 'INR')
      add(
        `Cost FX version does not match price currency: ${meterKey} (${fx ? `FX ${reference.fxId} version ${reference.fxVersion} converts ${fx.baseCurrency} to ${fx.quoteCurrency}` : `FX ${reference.fxId} version ${reference.fxVersion} is not in the ledger`}; the card is priced in ${card.currency})`,
        meterKey,
      );
  }
  let meters: ReturnType<typeof metersFor>;
  try {
    meters = metersFor(input.selections, input.registry, {
      requiresInput: sessionRequiresInput(input.config),
    });
  } catch {
    // A selection with no applicable meter is compat's to report (meter_uncovered).
    return issues;
  }
  for (const row of meters) {
    const reference = policy.priceCards[row.meter.key];
    if (!reference) {
      add(`Cost meter is not configured: ${row.meter.key}`, row.meter.key);
      continue;
    }
    const card = cards.get(row.meter.key);
    if (!card) continue;
    // OPS-13 at admission (worker checkMeterModels): a card for another model is refused.
    const selection = input.selections[row.slot]!;
    const manifest = manifestKeys(
      input.registry.resolvePin(selection.pluginId, selection.version).definition.manifest,
    ).manifest;
    const model = bindingModel(selection.binding?.config, manifest.bindingSchema);
    if (model && !priceCardMatchesModel(card, model))
      add(
        `price_unknown_for_model: ${row.meter.key} (price card ${card.id} version ${card.version} prices ${card.model}, the binding runs ${model})`,
        row.meter.key,
      );
  }
  return issues;
}
