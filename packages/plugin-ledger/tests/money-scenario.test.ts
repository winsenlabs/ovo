import { priceUsage } from '@winsendotai/ovo-plugin-observability';
import { describe, expect, it } from 'vitest';
import {
  allocateMinor,
  calculateInrScenario,
  COST_LEDGER_SERVICE_KEY,
  COST_SCENARIO_SERVICE_KEY,
  convertMinor,
  createCostLedgerPlugin,
  parseDecimal,
  parseMinor,
  roundMinor,
  type InrScenarioInput,
} from '../src/index.ts';

function nativePrice(quantity: string, minorUnitsPerBlock: string, blockQuantity: string): string {
  return priceUsage(
    {
      id: 'usage',
      workspaceId: 'compat',
      sessionId: 'session',
      provider: 'fixture',
      providerRequestId: 'request',
      quantity,
      unit: 'native',
      state: 'estimated',
    },
    {
      id: 'card',
      version: 'v1',
      provider: 'fixture',
      unit: 'native',
      currency: 'INR',
      minorUnitsPerBlock,
      blockQuantity,
    },
  ).amountMinor;
}

describe('exact cost arithmetic', () => {
  it('parses decimals as reduced BigInt rationals', () => {
    expect(parseDecimal('12.50')).toEqual({ numerator: 25n, denominator: 2n });
  });

  it('rejects exponent, noncanonical, and negative native quantities', () => {
    for (const value of ['1e3', '01', '-1', 'NaN']) expect(() => parseDecimal(value)).toThrow();
  });

  it('parses signed correction minor units without Number conversion', () => {
    expect(parseMinor('-999999999999999999999999', true)).toBe(-999999999999999999999999n);
  });

  it('rounds positive exact halves up', () => {
    expect(roundMinor({ numerator: 1n, denominator: 2n })).toBe(1n);
  });

  it('rounds negative exact halves away from zero', () => {
    expect(roundMinor({ numerator: -1n, denominator: 2n })).toBe(-1n);
  });

  it('prices fractional native units once at the row boundary', () => {
    expect(nativePrice('1500', '7', '1000')).toBe('11');
  });

  it('prices very large usage without floating-point loss', () => {
    expect(nativePrice('999999999999999999999999', '3', '1')).toBe('2999999999999999999999997');
  });

  it('converts provider minor units to paise using explicit rational FX', () => {
    expect(convertMinor('123', '8345', '100')).toBe('10264');
  });

  it('allocates every paise using stable largest remainders', () => {
    expect(
      Object.fromEntries(
        allocateMinor('10', [
          { id: 'c', weight: '1' },
          { id: 'a', weight: '1' },
          { id: 'b', weight: '1' },
        ]),
      ),
    ).toEqual({ a: '4', b: '3', c: '3' });
  });

  it('allocates weighted retries and transfers exactly', () => {
    const rows = allocateMinor('101', [
      { id: 'failed', weight: '1' },
      { id: 'transfer', weight: '2' },
      { id: 'retry', weight: '3' },
    ]);
    expect([...rows.values()].reduce((sum, value) => sum + BigInt(value), 0n)).toBe(101n);
    expect(rows.get('retry')).toBe('50');
  });

  it('rejects all-zero allocation weights', () => {
    expect(() => allocateMinor('10', [{ id: 'zero', weight: '0' }])).toThrow('positive');
  });
});

describe('explicit INR scenario service', () => {
  const scenario = (): InrScenarioInput => ({
    targetRevenuePaise: '1000',
    durationSeconds: '120',
    components: [
      {
        id: 'tel',
        category: 'telephony',
        amountMinor: '250',
        currency: 'INR',
        assumption: 'two connected carrier minutes',
      },
      {
        id: 'tax',
        category: 'tax',
        amountMinor: '45',
        currency: 'INR',
        assumption: 'explicit fixture tax',
      },
      {
        id: 'tts',
        category: 'speech-generation',
        amountMinor: '100',
        currency: 'USD',
        assumption: 'one generated approved phrase',
        fx: {
          id: 'usd-inr',
          version: '2026-09-20',
          baseCurrency: 'USD',
          quoteCurrency: 'INR',
          rateNumerator: '83',
          rateDenominator: '100',
        },
      },
      {
        id: 'media',
        category: 'carrier-media',
        amountMinor: '120',
        currency: 'INR',
        assumption: 'media remains billable on cache hits',
      },
      {
        id: 'idle',
        category: 'idle',
        amountMinor: '75',
        currency: 'INR',
        assumption: 'allocated warm worker idle share',
      },
    ],
    cache: {
      generatedUnits: '1',
      hitUnits: '3',
      generationBilledOnce: true,
      carrierMediaStillBilled: true,
      assumption: 'exact approved phrase fixture',
    },
    marginScope: 'contribution after listed costs only; excludes unlisted overhead',
  });

  it('computes the explicit ₹10/two-minute scenario in paise', () => {
    expect(calculateInrScenario(scenario())).toMatchObject({
      targetRevenuePaise: '1000',
      durationSeconds: '120',
      totalCostPaise: '573',
      marginPaise: '427',
      withinTarget: true,
    });
  });

  it('keeps FX, cache, tax, idle and margin assumptions in the result', () => {
    const result = calculateInrScenario(scenario());
    expect(result.components.find((row) => row.id === 'tts')?.fx?.version).toBe('2026-09-20');
    expect(result.cache.carrierMediaStillBilled).toBe(true);
    expect(result.marginScope).toContain('excludes');
  });

  it('requires every named scenario cost instead of fabricating defaults', () => {
    const input = scenario();
    input.components = input.components.filter((row) => row.category !== 'idle');
    expect(() => calculateInrScenario(input)).toThrow('idle');
  });

  it('requires explicit versioned FX for non-INR components', () => {
    const input = scenario();
    delete input.components.find((row) => row.currency === 'USD')!.fx;
    expect(() => calculateInrScenario(input)).toThrow('FX');
  });

  it('reports a negative margin without hiding costs', () => {
    const input = scenario();
    input.targetRevenuePaise = '100';
    expect(calculateInrScenario(input)).toMatchObject({ marginPaise: '-473', withinTarget: false });
  });
});

describe('cost ledger plugin contract', () => {
  it('is process scoped and exports ledger plus scenario services', () => {
    const plugin = createCostLedgerPlugin();
    expect(plugin.manifest.scope).toBe('process');
    expect(plugin.manifest.provides).toEqual([COST_LEDGER_SERVICE_KEY, COST_SCENARIO_SERVICE_KEY]);
  });
});
