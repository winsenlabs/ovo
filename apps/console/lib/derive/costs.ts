// Pure aggregation for the Costs screen: turns BudgetSnapshot / PriceCatalogItem / ScenarioResult
// rows into chart-ready shapes. No fetching, no formatting beyond what the charts need — display
// formatting (₹, humanised enums) stays in lib/format.ts and lib/status.ts.
import type { MeterSegment } from '../../components/charts/meter';
import type { DonutSlice } from '../../components/charts/donut';
import type { BarSeriesPoint } from '../../components/charts/bar-chart';
import { humaniseEnum } from '../status';
import type { BudgetSnapshot, ScenarioResult } from '../operator-api';
import type { PriceCatalogItem } from '../types/price-catalog';

const rupees = (paise: string): number => {
  const value = Number(paise);
  return Number.isFinite(value) ? value / 100 : 0;
};

/** Spent + reserved as meter segments against the limit, in rupees (display only — never used for
 * ledger math, which stays in exact paise on the server). */
export function budgetMeter(budget: BudgetSnapshot): { segments: MeterSegment[]; max: number } {
  return {
    segments: [
      { label: 'Spent', value: rupees(budget.spentPaise), tone: 'ok' },
      { label: 'Reserved', value: rupees(budget.reservedPaise), tone: 'warn' },
    ],
    max: rupees(budget.limitPaise),
  };
}

const STATUS_LABEL: Record<PriceCatalogItem['status'], string> = {
  imported: 'Imported',
  not_imported: 'Not imported',
  update_available: 'Update available',
};

/** Catalog entries grouped by import status, for the coverage donut. */
export function catalogStatusSlices(catalog: readonly PriceCatalogItem[]): DonutSlice[] {
  const counts = new Map<PriceCatalogItem['status'], number>();
  for (const entry of catalog) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, value]) => ({ label: STATUS_LABEL[status], value }));
}

/** One bar per cost component category, for the scenario breakdown chart. */
export function scenarioBreakdownBars(result: ScenarioResult): BarSeriesPoint[] {
  return result.components.map((component) => ({
    category: humaniseEnum(component.category),
    values: { amount: rupees(component.amountPaise) },
  }));
}

/** Cost components as meter segments against the target revenue — the same "spent vs ceiling"
 * shape as a budget, so the shared ProgressMeter can show the scenario's within/exceeded state. */
export function scenarioMeter(result: ScenarioResult): { segments: MeterSegment[]; max: number } {
  return {
    segments: result.components.map((component) => ({
      label: humaniseEnum(component.category),
      value: rupees(component.amountPaise),
    })),
    max: rupees(result.targetRevenuePaise),
  };
}

export const CATALOG_STATUS_LABEL: Record<PriceCatalogItem['status'], string> = {
  imported: 'Imported',
  not_imported: 'Not imported',
  update_available: 'Update available',
};

export const CATALOG_STATUS_TONE: Record<PriceCatalogItem['status'], 'ok' | 'warn'> = {
  imported: 'ok',
  not_imported: 'warn',
  update_available: 'warn',
};

/** `10 USD minor / 1000000 uncached_input_tokens` -> "$0.10 per 1M input tokens". */
export function humanisePrice(card: PriceCatalogItem['card']): string {
  const minorPerBlock = Number(card.minorUnitsPerBlock);
  const block = Number(card.blockQuantity);
  if (!Number.isFinite(minorPerBlock) || !Number.isFinite(block) || block <= 0)
    return `${card.minorUnitsPerBlock} ${card.currency} minor / ${card.blockQuantity} ${card.unit}`;
  const scale = block >= 1_000_000 ? 1_000_000 : block >= 1_000 ? 1_000 : 1;
  const scaleLabel = scale === 1_000_000 ? '1M' : scale === 1_000 ? '1K' : '1';
  const amount = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: card.currency,
    maximumFractionDigits: 4,
  }).format((minorPerBlock / 100 / block) * scale);
  return `${amount} per ${scaleLabel} ${card.unit.replace(/_/g, ' ')}`;
}
