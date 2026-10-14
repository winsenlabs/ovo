import { expect, it } from 'vitest';
import { budgetMeter, catalogStatusSlices, scenarioBreakdownBars, scenarioMeter } from './costs';
import type { BudgetSnapshot, ScenarioResult } from '../operator-api';
import type { PriceCatalogItem } from '../types/price-catalog';

const budget: BudgetSnapshot = {
  id: 'b1',
  workspaceId: 'w1',
  limitPaise: '100000',
  admissionOverspendPaise: '0',
  spentPaise: '40000',
  reservedPaise: '10000',
  availableForAdmissionPaise: '50000',
  overLimit: false,
};

it('converts a budget into spent/reserved meter segments in rupees', () => {
  expect(budgetMeter(budget)).toEqual({
    segments: [
      { label: 'Spent', value: 400, tone: 'ok' },
      { label: 'Reserved', value: 100, tone: 'warn' },
    ],
    max: 1000,
  });
});

it('groups catalog entries by status for the coverage donut', () => {
  const catalog = [
    { status: 'imported' },
    { status: 'imported' },
    { status: 'not_imported' },
  ] as unknown as PriceCatalogItem[];
  expect(catalogStatusSlices(catalog)).toEqual([
    { label: 'Imported', value: 2 },
    { label: 'Not imported', value: 1 },
  ]);
});

const scenario: ScenarioResult = {
  targetRevenuePaise: '100000',
  durationSeconds: '60',
  totalCostPaise: '60000',
  marginPaise: '40000',
  withinTarget: true,
  marginScope: 'Per completed call',
  components: [
    {
      id: 'telephony',
      category: 'telephony',
      amountPaise: '20000',
      currency: 'INR',
      assumption: 'x',
    },
    { id: 'tax', category: 'tax', amountPaise: '40000', currency: 'INR', assumption: 'y' },
  ],
};

it('builds one breakdown bar per cost component, humanised', () => {
  expect(scenarioBreakdownBars(scenario)).toEqual([
    { category: 'Telephony', values: { amount: 200 } },
    { category: 'Tax', values: { amount: 400 } },
  ]);
});

it('builds a scenario meter against the target revenue', () => {
  expect(scenarioMeter(scenario)).toEqual({
    segments: [
      { label: 'Telephony', value: 200 },
      { label: 'Tax', value: 400 },
    ],
    max: 1000,
  });
});
